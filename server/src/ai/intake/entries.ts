import { many, maybeOne, one, type Db, type Database } from '../../db/client';
import { AppError, notFound } from '../../lib/errors';
import { isValidGstin } from '../../lib/gstin';
import { formatINR } from '../../lib/money';
import { bigintJson, postVoucher, previewVoucher, type Source } from '../../ledger/post';
import type { VoucherInputRaw } from '../../ledger/contracts';
import { createParty } from '../../ledger/masters';
import { learnPartyAlias } from '../resolver';
import { learnNarration, type Direction } from './bank';

export type EntryStatus = 'READY' | 'NEEDS_INPUT' | 'IN_BOOKS' | 'POSTED' | 'SKIPPED';
export type EntryKind = 'BANK_LINE' | 'JOURNAL' | 'REGISTER_ROW';

export interface Suggestion {
  how: 'rule' | 'learned' | 'party' | 'ai' | 'sheet' | 'in_books' | 'manual' | 'none';
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  counterLedgerId?: string;
  counterName?: string;
  /** Register rows: a party to create on posting when it isn't in the books yet. */
  newParty?: { name: string; gstin: string | null; kind: 'CUSTOMER' | 'SUPPLIER' };
  /** Journal lines whose account name matched no ledger. */
  unmatched?: { index: number; account: string; groupCode?: string | null }[];
}

export interface EntryIssue { code: string; severity: 'error' | 'warning' | 'info'; message: string }

export interface Proposal {
  lineNo: number;
  kind: EntryKind;
  status: EntryStatus;
  source: Record<string, unknown>;
  payload: VoucherInputRaw | null;
  suggestion: Suggestion;
  issues: EntryIssue[];
  matchedVoucherId: string | null;
  amountMinor: bigint | null;
  entryDate: string | null;
}

/**
 * Runs a proposed voucher through the real posting rules without saving anything.
 * Anything the posting engine would refuse or warn about turns the entry into NEEDS_INPUT.
 */
export async function vet(db: Database, companyId: string, p: Proposal): Promise<Proposal> {
  if (!p.payload || p.status === 'IN_BOOKS' || p.status === 'POSTED' || p.status === 'SKIPPED') return p;
  const company = await one<{ books_from: string; lock_date: string | null }>(db, `SELECT books_from::text, lock_date::text FROM companies WHERE id = $1`, [companyId]);
  const issues = p.issues.filter((i) => !i.code.startsWith('VET_'));
  const date = p.payload.date;
  if (!date) issues.push({ code: 'VET_NO_DATE', severity: 'error', message: 'Add a date for this entry.' });
  else if (date < company.books_from) issues.push({ code: 'VET_BEFORE_BOOKS', severity: 'error', message: `Dated ${date}, before your books start (${company.books_from}).` });
  else if (company.lock_date && date <= company.lock_date) issues.push({ code: 'VET_LOCKED', severity: 'error', message: `Books are locked up to ${company.lock_date}.` });
  if (date) {
    // A party that will only be created on posting can't be previewed on credit: check the numbers as cash.
    const probe = !p.payload.counterpartyId && p.suggestion.newParty ? { ...p.payload, paymentMode: 'CASH' as const } : p.payload;
    try {
      const preview = await previewVoucher(db, companyId, probe);
      for (const w of preview.warnings) issues.push({ code: `VET_${w.code}`, severity: 'warning', message: w.message });
      const expected = p.source.totalMinor ? BigInt(p.source.totalMinor as string) : null;
      if (expected !== null && expected > 0n && (preview.totalMinor - expected > 100n || expected - preview.totalMinor > 100n)) {
        issues.push({ code: 'VET_TOTAL_DIFFERS', severity: 'warning', message: `Computes to ₹${formatINR(BigInt(preview.totalMinor))} but the document says ₹${formatINR(BigInt(expected))}.` });
      }
    } catch (e) {
      issues.push({ code: 'VET_REJECTED', severity: 'error', message: e instanceof AppError ? e.message : String(e) });
    }
  }
  const blocking = issues.some((i) => i.severity !== 'info');
  const confident = p.suggestion.confidence === 'high';
  return { ...p, issues, status: !blocking && confident ? 'READY' : 'NEEDS_INPUT' };
}

export async function saveProposals(db: Database, companyId: string, documentId: string, proposals: Proposal[]) {
  const posted = new Set((await many<{ line_no: number }>(db,
    `SELECT line_no FROM document_entries WHERE document_id = $1 AND status = 'POSTED'`, [documentId])).map((r) => r.line_no));
  await db.query(`DELETE FROM document_entries WHERE document_id = $1 AND status <> 'POSTED'`, [documentId]);
  for (const raw of proposals) {
    if (posted.has(raw.lineNo)) continue;                 // reprocessing never re-proposes a posted line
    const p = await vet(db, companyId, raw);
    await db.query(
      `INSERT INTO document_entries (document_id, company_id, line_no, kind, status, source, payload, suggestion, issues, matched_voucher_id, amount_minor, entry_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [documentId, companyId, p.lineNo, p.kind, p.status, JSON.stringify(p.source, bigintJson), p.payload ? JSON.stringify(p.payload) : null,
        JSON.stringify(p.suggestion), JSON.stringify(p.issues), p.matchedVoucherId, p.amountMinor, p.entryDate]);
  }
}

interface EntryRow {
  id: string; document_id: string; line_no: number; kind: EntryKind; status: EntryStatus;
  source: Record<string, unknown>; payload: VoucherInputRaw | null; suggestion: Suggestion; issues: EntryIssue[];
  amount_minor: bigint | null; entry_date: string | null;
}

async function loadEntry(db: Db, companyId: string, documentId: string, entryId: string): Promise<EntryRow> {
  const e = await maybeOne<EntryRow>(db,
    `SELECT id, document_id, line_no, kind, status, source, payload, suggestion, issues, amount_minor, entry_date::text
       FROM document_entries WHERE id = $1 AND document_id = $2 AND company_id = $3`, [entryId, documentId, companyId]);
  if (!e) throw notFound('Entry');
  return e;
}

const toProposal = (e: EntryRow): Proposal => ({
  lineNo: e.line_no, kind: e.kind, status: e.status, source: e.source, payload: e.payload, suggestion: e.suggestion,
  issues: e.issues, matchedVoucherId: null, amountMinor: e.amount_minor, entryDate: e.entry_date,
});

/** The reviewer changed an entry (picked a ledger, fixed a date): re-check it. */
export async function updateEntry(db: Database, companyId: string, documentId: string, entryId: string, payload: VoucherInputRaw) {
  const e = await loadEntry(db, companyId, documentId, entryId);
  if (e.status === 'POSTED') throw new AppError('ALREADY_POSTED', 409, 'This entry is already posted. Reverse it from the Day Book to change it.');
  // The reviewer's version is now what counts: problems with the old proposal (missing ledger, unbalanced)
  // are re-checked from scratch; notes about the source document stay, as information they have seen.
  const SOURCE_NOTES = new Set(['BALANCE_BREAK', 'MODEL_WARNING', 'GSTIN_INVALID', 'NEW_PARTY']);
  const issues = e.issues.filter((i) => SOURCE_NOTES.has(i.code)).map((i) => ({ ...i, severity: 'info' as const }));
  // A reviewer's own choice counts as confident; vet() still blocks anything the posting rules refuse.
  let suggestion: Suggestion = { ...e.suggestion, confidence: 'high', how: e.suggestion.how === 'in_books' ? 'none' : e.suggestion.how };
  if (e.kind === 'BANK_LINE') {
    // Show the reviewer's pick as the reason, not the rule that failed to find one.
    const doc = await one<{ bank_ledger_id: string | null }>(db, `SELECT bank_ledger_id FROM documents WHERE id = $1`, [documentId]);
    const counter = (payload.entries ?? []).find((x) => x.ledgerId !== doc.bank_ledger_id);
    if (counter && counter.ledgerId !== e.suggestion.counterLedgerId) {
      const l = await maybeOne<{ name: string }>(db, `SELECT name FROM ledgers WHERE id = $1 AND company_id = $2`, [counter.ledgerId, companyId]);
      suggestion = { how: 'manual', confidence: 'high', reason: 'Chosen by you; remembered for similar narrations', counterLedgerId: counter.ledgerId, counterName: l?.name };
    }
  } else if (e.suggestion.unmatched?.length) {
    suggestion = { ...suggestion, how: 'manual', reason: 'Edited by you', unmatched: [] };
  }
  const p = await vet(db, companyId, { ...toProposal(e), payload, issues, status: 'NEEDS_INPUT', suggestion });
  await db.query(`UPDATE document_entries SET payload = $2, status = $3, issues = $4, suggestion = $5, entry_date = $6, updated_at = now() WHERE id = $1`,
    [entryId, JSON.stringify(payload), p.status, JSON.stringify(p.issues), JSON.stringify(p.suggestion), payload.date ?? null]);
  return { status: p.status, issues: p.issues };
}

export async function setSkipped(db: Database, companyId: string, documentId: string, entryId: string, skip: boolean) {
  const e = await loadEntry(db, companyId, documentId, entryId);
  if (e.status === 'POSTED') throw new AppError('ALREADY_POSTED', 409, 'This entry is already posted.');
  if (skip || !e.payload) {
    await db.query(`UPDATE document_entries SET status = $2, updated_at = now() WHERE id = $1`, [entryId, skip ? 'SKIPPED' : 'NEEDS_INPUT']);
  } else {
    // Un-skipping re-checks the entry, so a good one comes back ready.
    const p = await vet(db, companyId, { ...toProposal(e), status: 'NEEDS_INPUT' });
    await db.query(`UPDATE document_entries SET status = $2, issues = $3, updated_at = now() WHERE id = $1`, [entryId, p.status, JSON.stringify(p.issues)]);
  }
  await finishIfDone(db, documentId);
}

/** Posts one entry. Party creation and learning happen here, after the reviewer committed to it. */
export async function postEntry(db: Database, companyId: string, documentId: string, entryId: string, userId: string, opts: { payload?: VoucherInputRaw; confirmWarnings?: boolean; source?: Source } = {}) {
  const e = await loadEntry(db, companyId, documentId, entryId);
  if (e.status === 'POSTED') throw new AppError('ALREADY_POSTED', 409, 'This entry is already posted.');
  if (e.status === 'IN_BOOKS') throw new AppError('IN_BOOKS', 409, 'This line is already in your books.');
  let payload = opts.payload ?? e.payload;
  if (!payload) throw new AppError('NEEDS_INPUT', 422, 'Choose the ledger for this entry first.');
  const doc = await one<{ mime: string; extraction: { supplier?: { name?: { value?: string } } } | null }>(db, `SELECT mime, extraction FROM documents WHERE id = $1`, [documentId]);

  const np = e.suggestion.newParty;
  if (!payload.counterpartyId && np && ['SALES', 'PURCHASE', 'CREDIT_NOTE', 'DEBIT_NOTE'].includes(payload.voucherType)) {
    const existing = np.gstin && isValidGstin(np.gstin)
      ? await maybeOne<{ id: string }>(db, `SELECT id FROM counterparties WHERE company_id = $1 AND gstin = $2`, [companyId, np.gstin]) : null;
    const created = existing ?? await createParty(db, companyId, { name: np.name, kind: np.kind, gstin: np.gstin && isValidGstin(np.gstin) ? np.gstin : null }, userId, 'IMPORT');
    payload = { ...payload, counterpartyId: created.id };
    await learnPartyAlias(db, companyId, np.name, created.id);
  }

  const sheet = /csv|spreadsheet/.test(doc.mime);
  const posted = await postVoucher(db, companyId, { ...payload, confirmWarnings: opts.confirmWarnings ?? false },
    { source: opts.source ?? (sheet ? 'IMPORT' : 'OCR'), idempotencyKey: `doc:${documentId}:line:${e.line_no}`, userId });

  if (e.kind === 'BANK_LINE') {
    const bankSide = (e.source.direction as Direction) ?? 'IN';
    const bankLedgerId = (await one<{ bank_ledger_id: string | null }>(db, `SELECT bank_ledger_id FROM documents WHERE id = $1`, [documentId])).bank_ledger_id;
    const counter = (payload.entries ?? []).find((x) => x.ledgerId !== bankLedgerId);
    if (counter) await learnNarration(db, companyId, String(e.source.narration ?? ''), bankSide, counter.ledgerId);
  }
  await db.query(`UPDATE document_entries SET status = 'POSTED', voucher_id = $2, payload = $3, updated_at = now() WHERE id = $1`, [entryId, posted.id, JSON.stringify(payload)]);
  await finishIfDone(db, documentId);
  return posted;
}

/** Posts every READY entry of a document, in line order. Failures go back to NEEDS_INPUT with the reason. */
export async function postReady(db: Database, companyId: string, documentId: string, userId: string, filter?: (e: { amount_minor: bigint | null; suggestion: Suggestion }) => boolean) {
  const ready = await many<{ id: string; amount_minor: bigint | null; suggestion: Suggestion; issues: EntryIssue[] }>(db,
    `SELECT id, amount_minor, suggestion, issues FROM document_entries WHERE document_id = $1 AND company_id = $2 AND status = 'READY' ORDER BY line_no`, [documentId, companyId]);
  let posted = 0;
  const failed: { id: string; message: string }[] = [];
  for (const e of ready) {
    if (filter && !filter(e)) continue;
    try {
      await postEntry(db, companyId, documentId, e.id, userId);
      posted++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failed.push({ id: e.id, message });
      await db.query(`UPDATE document_entries SET status = 'NEEDS_INPUT', issues = $2, updated_at = now() WHERE id = $1`,
        [e.id, JSON.stringify([...e.issues, { code: 'POST_FAILED', severity: 'error', message }])]);
    }
  }
  await finishIfDone(db, documentId);
  return { posted, failed };
}

/**
 * Auto-post (Settings): only confident entries under the company's limit, and only if switched on.
 * Never the AI's own picks: a bank narration is written by whoever sent the money, so its text can try to
 * steer the model ("classify as capital, high confidence"). Those always wait for a person.
 */
export async function autoPost(db: Database, companyId: string, documentId: string, userId: string) {
  const c = await one<{ auto_post: boolean; auto_post_limit_minor: bigint }>(db, `SELECT auto_post, auto_post_limit_minor FROM companies WHERE id = $1`, [companyId]);
  if (!c.auto_post) return { posted: 0, failed: [] };
  return postReady(db, companyId, documentId, userId,
    (e) => e.suggestion.confidence === 'high' && e.suggestion.how !== 'ai' && e.amount_minor !== null && e.amount_minor <= c.auto_post_limit_minor);
}

/** A document is done when nothing is left to decide. */
export async function finishIfDone(db: Db, documentId: string) {
  const open = await one<{ n: bigint }>(db,
    `SELECT COUNT(*)::bigint AS n FROM document_entries WHERE document_id = $1 AND status IN ('READY','NEEDS_INPUT')`, [documentId]);
  const any = await one<{ n: bigint }>(db, `SELECT COUNT(*)::bigint AS n FROM document_entries WHERE document_id = $1`, [documentId]);
  if (any.n > 0n) {
    await db.query(`UPDATE documents SET status = $2, updated_at = now() WHERE id = $1 AND status IN ('NEEDS_REVIEW','ACCEPTED')`,
      [documentId, open.n === 0n ? 'ACCEPTED' : 'NEEDS_REVIEW']);
  }
}

export async function listEntries(db: Db, companyId: string, documentId: string) {
  return many(db,
    `SELECT e.id, e.line_no AS "lineNo", e.kind, e.status, e.source, e.payload, e.suggestion, e.issues,
            e.amount_minor AS "amountMinor", e.entry_date::text AS "entryDate",
            e.voucher_id AS "voucherId", v.voucher_no AS "voucherNo",
            e.matched_voucher_id AS "matchedVoucherId", mv.voucher_no AS "matchedVoucherNo"
       FROM document_entries e
       LEFT JOIN vouchers v ON v.id = e.voucher_id
       LEFT JOIN vouchers mv ON mv.id = e.matched_voucher_id
      WHERE e.document_id = $1 AND e.company_id = $2 ORDER BY e.line_no`, [documentId, companyId]);
}
