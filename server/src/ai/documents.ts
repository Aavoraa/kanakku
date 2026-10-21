import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Decimal from 'decimal.js';
import { many, maybeOne, one, type Db, type Database } from '../db/client';
import { config } from '../config';
import { AppError, notFound } from '../lib/errors';
import { addDays, shortDate, todayIST } from '../lib/dates';
import { isValidGstin, gstinState, stateCodeFrom } from '../lib/gstin';
import { formatINR, fromMinor } from '../lib/money';
import { decToMinor, parseAmount } from '../lib/parse';
import { normName } from '../lib/text';
import { KNOWN_GST_RATES_PPM } from '../tax/india-gst';
import { LedgerContext } from '../ledger/context';
import { createParty, type NewParty } from '../ledger/masters';
import { audit, bigintJson, postVoucher, previewVoucher } from '../ledger/post';
import type { BaseType, VoucherInputRaw } from '../ledger/contracts';
import { BILL_PROMPT, extractBill, type BillMedia } from './extract-bill';
import type { ParsedBill } from './bill-schema';
import { dec, lineTaxable } from './bill-numbers';
import { learnLine, learnPartyAlias, resolveLine, resolveParty, type LineResolution, type PartyResolution } from './resolver';
import { validateBill } from './validators';
import { classifyFile, readSheets, sheetToText, type FileKind } from './intake/files';
import { checkStatement, parseStatementSheet, findStatementHeader, type Statement } from './intake/statement';
import { parseJournalSheet, parseRegisterSheet } from './intake/sheets';
import { bankPayload, direction, lineAmount, proposeBankLines } from './intake/bank';
import { autoPost, finishIfDone, saveProposals, type Proposal } from './intake/entries';
import { proposeJournal, proposeRegister } from './intake/proposals';
import { classifyBankLines, classifyDocument, extractStatement, extractWorkings, mediaBlock, type AccountForAi, type DocType } from './intake/llm';

const MAX_BYTES = 20 * 1024 * 1024;

/** What the uploader told us (all optional): force a type, the bank account, the register side. */
export interface DocOptions {
  docType?: DocType | 'REGISTER' | null;
  bankLedgerId?: string | null;
  registerKind?: 'SALES' | 'PURCHASE' | null;
  date?: string | null;            // fallback date for workings without one
}

export async function ingestDocument(db: Database, companyId: string, file: { name: string; mime: string; data: Buffer }, uploadedBy: string, options: DocOptions = {}) {
  // Files are kept on the server's disk and read in the background, and the demo's servers have neither.
  if (config.demo) throw new AppError('DEMO', 403, 'Uploading documents is not available on the online demo. Install Kannaku AI on your computer to try it.');
  const { mime } = classifyFile(file.name, file.mime);
  if (file.data.length > MAX_BYTES) throw new AppError('FILE_TOO_LARGE', 413, 'Files must be under 20 MB');
  const sha = crypto.createHash('sha256').update(file.data).digest('hex');
  const existing = await maybeOne<{ id: string; status: string }>(db, `SELECT id, status FROM documents WHERE company_id = $1 AND sha256 = $2`, [companyId, sha]);
  if (existing) throw new AppError('DUPLICATE_FILE', 409, 'This exact file was already uploaded', { documentId: existing.id, status: existing.status });
  fs.mkdirSync(config.uploadDir, { recursive: true });
  const ext = path.extname(file.name).toLowerCase().replace(/[^.a-z0-9]/g, '') || '';
  const key = `${sha}${ext}`;
  fs.writeFileSync(path.join(config.uploadDir, key), file.data);
  const doc = await one<{ id: string }>(db,
    `INSERT INTO documents (company_id, sha256, file_name, storage_key, mime, size_bytes, status, uploaded_by, options)
     VALUES ($1,$2,$3,$4,$5,$6,'RECEIVED',$7,$8) RETURNING id`,
    [companyId, sha, file.name.slice(0, 200), key, mime, file.data.length, uploadedBy, JSON.stringify(options)]);
  enqueue(db, doc.id);
  return doc;
}

// ---------- Background queue (in-process; swap for pg-boss on a server deployment) ----------
const queue: string[] = [];
let running = 0;
const CONCURRENCY = 2;

/** Documents queued or being read; a document is never in the queue twice. */
const active = new Set<string>();

export function enqueue(db: Database, documentId: string) {
  if (active.has(documentId)) return;
  active.add(documentId);
  queue.push(documentId);
  pump(db);
}

function pump(db: Database) {
  while (running < CONCURRENCY && queue.length) {
    const id = queue.shift()!;
    running++;
    processDocument(db, id)
      .catch((e) => console.error(`[documents] ${id} failed:`, e))
      .finally(() => { running--; active.delete(id); pump(db); });
  }
}

export async function resumePending(db: Database) {
  const pending = await many<{ id: string }>(db, `SELECT id FROM documents WHERE status IN ('RECEIVED','PROCESSING') ORDER BY created_at`);
  for (const d of pending) enqueue(db, d.id);
}

interface DocRow { id: string; company_id: string; file_name: string; storage_key: string; mime: string; uploaded_by: string | null; options: DocOptions }

const kindOf = (mime: string): FileKind =>
  mime === 'text/csv' ? 'csv' : mime.includes('spreadsheetml') ? 'sheet' : mime === 'application/pdf' ? 'pdf' : 'image';

export async function processDocument(db: Database, documentId: string) {
  const doc = await one<DocRow>(db,
    `SELECT id, company_id, file_name, storage_key, mime, uploaded_by, options FROM documents WHERE id = $1`, [documentId]);
  await db.query(`UPDATE documents SET status = 'PROCESSING', error = NULL, updated_at = now() WHERE id = $1`, [documentId]);
  const userId = doc.uploaded_by ?? config.localUserId;
  try {
    const ctx = await LedgerContext.load(db, doc.company_id);
    const data = fs.readFileSync(path.join(config.uploadDir, doc.storage_key));
    const kind = kindOf(doc.mime);
    const opts = doc.options ?? {};

    if (kind === 'sheet' || kind === 'csv') {
      await processSpreadsheet(db, ctx, doc, data, kind, opts, userId);
      return;
    }
    if (!config.aiEnabled) {
      throw new AppError('AI_DISABLED', 503, 'Reading PDFs and photos needs the AI: click "AI off" in the top bar to add your API key. Excel and CSV files work without it.');
    }
    const type: DocType = opts.docType && opts.docType !== 'REGISTER' ? opts.docType : await detectType(data, doc.mime, ctx);
    if (type === 'BANK_STATEMENT') {
      const x = await extractStatement(data, doc.mime, ctx.company);
      await finishStatement(db, ctx, doc, statementFromExtract(x), opts, userId, 'BANK_STATEMENT');
    } else if (type === 'WORKINGS') {
      await finishWorkings(db, ctx, doc, [mediaBlock(data, doc.mime)], opts, userId);
    } else if (type === 'OTHER') {
      throw new AppError('NOT_FINANCIAL', 422, 'This does not look like a bill, invoice, bank statement or working. Choose the type when uploading if it is one.');
    } else {
      await processBill(db, ctx, doc, data, type, userId);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await db.query(`UPDATE documents SET status = 'FAILED', error = $2, updated_at = now() WHERE id = $1`, [documentId, message.slice(0, 1000)]);
  }
}

/** Classifier verdict, corrected by code where code knows better (our own GSTIN on the document = issued by us). */
async function detectType(data: Buffer, mime: string, ctx: LedgerContext): Promise<DocType> {
  const c = await classifyDocument(data, mime, ctx.company);
  const ours = Boolean(ctx.company.gstin && c.issuer_gstin && c.issuer_gstin.replace(/\s/g, '').toUpperCase() === ctx.company.gstin);
  if (ours && c.doc_type === 'PURCHASE_BILL') return 'SALES_INVOICE';
  if (ours && c.doc_type === 'CREDIT_NOTE_RECEIVED') return 'CREDIT_NOTE_ISSUED';
  if (ours && c.doc_type === 'DEBIT_NOTE_RECEIVED') return 'DEBIT_NOTE_ISSUED';
  if (!ours && c.doc_type === 'SALES_INVOICE' && ctx.company.gstin && c.issuer_gstin) return 'PURCHASE_BILL';
  return c.doc_type;
}

// ---------------------------------------------------------------- Spreadsheets (no AI needed)
async function processSpreadsheet(db: Database, ctx: LedgerContext, doc: DocRow, data: Buffer, kind: 'sheet' | 'csv', opts: DocOptions, userId: string) {
  const sheets = await readSheets(data, kind);
  const proposals: Proposal[] = [];
  const found: { sheet: string; kind: string; rows: number }[] = [];
  let statement: Statement | null = null;
  let offset = 0;
  const add = (ps: Proposal[]) => { for (const p of ps) proposals.push({ ...p, lineNo: p.lineNo + offset }); offset += ps.length; };

  for (const sheet of sheets) {
    const forced = opts.docType;
    const register = forced === 'BANK_STATEMENT' || forced === 'WORKINGS' ? null : parseRegisterSheet(sheet);
    if (register && (!forced || forced === 'REGISTER' || forced === 'SALES_INVOICE' || forced === 'PURCHASE_BILL')) {
      const kindOverride = opts.registerKind ?? (forced === 'SALES_INVOICE' ? 'SALES' : forced === 'PURCHASE_BILL' ? 'PURCHASE' : null);
      add(await proposeRegister(db, ctx, register, kindOverride));
      found.push({ sheet: sheet.name, kind: `${(kindOverride ?? register.kind ?? 'unknown').toLowerCase()} register`, rows: register.rows.length });
      continue;
    }
    // A journal and a statement can look alike (Particulars / Debit / Credit); a Balance column means statement.
    const st = forced === 'WORKINGS' ? null : parseStatementSheet(sheet);
    const hasBalance = (findStatementHeader(sheet.rows)?.cols.balance ?? -1) >= 0;
    const journal = forced === 'BANK_STATEMENT' ? null : parseJournalSheet(sheet);
    if (st && (hasBalance || !journal || forced === 'BANK_STATEMENT')) {
      if (statement) { statement.lines.push(...st.lines.map((l) => ({ ...l, lineNo: statement!.lines.length + l.lineNo }))); statement.issues.push(...st.issues); }
      else statement = st;
      found.push({ sheet: sheet.name, kind: 'bank statement', rows: st.lines.length });
      continue;
    }
    if (journal) {
      for (const j of journal) add([await proposeJournal(db, ctx, j, opts.date ?? null)]);
      found.push({ sheet: sheet.name, kind: 'journal working', rows: journal.length });
    }
  }

  if (statement) {
    await finishStatement(db, ctx, doc, statement, opts, userId, 'BANK_STATEMENT', found);
    return;
  }
  if (!proposals.length) {
    if (!config.aiEnabled) {
      throw new AppError('UNRECOGNISED_SHEET', 422,
        'Could not recognise this sheet. Expected a bank statement (Date, Narration, Withdrawal, Deposit, Balance), a journal (Ledger, Debit, Credit) or an invoice register (Invoice No, Party, Taxable value). Free-form workings need the AI: click "AI off" in the top bar to add your API key.');
    }
    await finishWorkings(db, ctx, doc, [{ type: 'text', text: sheets.map((s) => sheetToText(s)).join('\n\n') }], opts, userId);
    return;
  }
  const docType = found.some((f) => f.kind.includes('register')) ? 'REGISTER' : 'WORKINGS';
  await saveAndFinish(db, ctx, doc, proposals, docType, { kind: docType, sheets: found }, userId);
}

async function saveAndFinish(db: Database, ctx: LedgerContext, doc: DocRow, proposals: Proposal[], docType: string, summary: Record<string, unknown>, userId: string, bankLedgerId: string | null = null) {
  await saveProposals(db, ctx.company.id, doc.id, proposals);
  await db.query(`UPDATE documents SET status = 'NEEDS_REVIEW', doc_type = $2, summary = $3, bank_ledger_id = $4, model = $5, updated_at = now() WHERE id = $1`,
    [doc.id, docType, JSON.stringify(summary, bigintJson), bankLedgerId, config.aiEnabled ? config.model : null]);
  await autoPost(db, ctx.company.id, doc.id, userId);
  await finishIfDone(db, doc.id);
}

// ---------------------------------------------------------------- Bank statements
function statementFromExtract(x: Awaited<ReturnType<typeof extractStatement>>): Statement {
  const m = (s: string | null) => { const d = parseAmount(s); return d ? decToMinor(d.abs()) : 0n; };
  const lines = x.transactions
    .filter((t) => t.date && (m(t.withdrawal) > 0n || m(t.deposit) > 0n))
    .map((t, i) => {
      const bal = parseAmount(t.balance);
      return { lineNo: i + 1, date: t.date!, narration: t.narration || '(no narration)', ref: t.reference, debitMinor: m(t.withdrawal), creditMinor: m(t.deposit), balanceMinor: bal ? decToMinor(bal) : null };
    });
  const open = parseAmount(x.opening_balance);
  const close = parseAmount(x.closing_balance);
  const digits = x.account_number?.replace(/[^0-9]/g, '') ?? '';
  const st: Statement = {
    bankName: x.bank_name, accountHint: digits.slice(-4) || null,
    periodFrom: lines[0]?.date ?? null, periodTo: lines[lines.length - 1]?.date ?? null,
    openingMinor: open ? decToMinor(open) : null, closingMinor: close ? decToMinor(close) : null, lines,
    issues: x.warnings.map((w) => ({ lineNo: null, code: 'MODEL_WARNING', severity: 'warning' as const, message: w })),
  };
  checkStatement(st);
  return st;
}

/** Which bank ledger the statement belongs to; creates one when the bank is new to the books. */
async function resolveBankLedger(db: Database, ctx: LedgerContext, st: Statement, opts: DocOptions): Promise<{ id: string; name: string; created: boolean; note: string | null }> {
  if (opts.bankLedgerId && ctx.isCashBank(opts.bankLedgerId)) return { id: opts.bankLedgerId, name: ctx.ledger(opts.bankLedgerId).name, created: false, note: null };
  const banks = ctx.bankLedgers();
  const bankWord = st.bankName ? normName(st.bankName).split(' ').find((w) => w.length > 2 && w !== 'bank') ?? null : null;
  const byHint = st.accountHint ? banks.find((b) => b.name.includes(st.accountHint!)) : null;
  const byName = bankWord ? banks.filter((b) => normName(b.name).includes(bankWord)) : [];
  const pick = byHint ?? (byName.length === 1 ? byName[0] : null) ?? (banks.length === 1 && (!bankWord || byName.length === 1) ? banks[0] : null);
  if (pick) return { id: pick.id, name: pick.name, created: false, note: null };
  if (!banks.length || bankWord) {
    // Not in the books yet: create the bank ledger so the statement can be posted.
    const name = `${st.bankName?.replace(/\s+/g, ' ').trim().slice(0, 40) || 'Bank Account'}${st.accountHint ? ` ****${st.accountHint}` : ''}`;
    const group = await one<{ id: string }>(db, `SELECT id FROM ledger_groups WHERE company_id = $1 AND system_code = 'BANK_ACCOUNTS'`, [ctx.company.id]);
    const existing = await maybeOne<{ id: string }>(db, `SELECT id FROM ledgers WHERE company_id = $1 AND lower(name) = lower($2)`, [ctx.company.id, name]);
    const row = existing ?? await one<{ id: string }>(db, `INSERT INTO ledgers (company_id, group_id, name, norm_name) VALUES ($1,$2,$3,$4) RETURNING id`, [ctx.company.id, group.id, name, normName(name)]);
    return { id: row.id, name, created: !existing, note: existing ? null : `Created bank ledger "${name}". Set its opening balance in Masters if the statement starts after your books do.` };
  }
  return { id: banks[0].id, name: banks[0].name, created: false, note: `Several bank accounts exist; assumed "${banks[0].name}". Change it above if that is wrong.` };
}

async function finishStatement(db: Database, ctx0: LedgerContext, doc: DocRow, st: Statement, opts: DocOptions, userId: string, docType: string, sheets?: unknown) {
  if (!st.lines.length) throw new AppError('EMPTY_STATEMENT', 422, 'No transactions were found in this statement.');
  const bank = await resolveBankLedger(db, ctx0, st, opts);
  const ctx = await LedgerContext.load(db, ctx0.company.id);    // includes a just-created bank ledger
  const proposals = await proposeBankLines(db, { ctx, bankLedgerId: bank.id, claimed: new Set() }, st);
  if (config.aiEnabled) await aiClassifyLeftovers(db, ctx, bank.id, st, proposals);

  // What the books say the bank balance was just before the statement starts.
  const books = await one<{ s: bigint }>(db, `SELECT COALESCE(SUM(amount_minor), 0)::bigint AS s FROM ledger_entries WHERE ledger_id = $1 AND voucher_date < $2`, [bank.id, st.periodFrom]);
  const summary = {
    kind: 'BANK_STATEMENT', sheets, bankName: st.bankName, accountHint: st.accountHint, bankLedgerId: bank.id, bankLedgerName: bank.name,
    createdBankLedger: bank.created, periodFrom: st.periodFrom, periodTo: st.periodTo, openingMinor: st.openingMinor, closingMinor: st.closingMinor,
    booksOpeningMinor: books.s,
    deposits: st.lines.reduce((s, l) => s + l.creditMinor, 0n), withdrawals: st.lines.reduce((s, l) => s + l.debitMinor, 0n),
    issues: [...st.issues.filter((i) => i.lineNo === null), ...(bank.note ? [{ lineNo: null, code: 'BANK_LEDGER', severity: 'info', message: bank.note }] : []),
      ...(st.openingMinor !== null && st.openingMinor !== books.s
        ? [{ lineNo: null, code: 'OPENING_DIFFERS', severity: 'info', message: `Your books show ₹${formatINR(books.s)} in ${bank.name} at the end of ${shortDate(addDays(st.periodFrom!, -1))}, but the statement opens at ₹${formatINR(st.openingMinor)}. Either entries from before this statement are missing, or the opening balance needs setting.` }] : [])],
  };
  await saveAndFinish(db, ctx, doc, proposals, docType, summary, userId, bank.id);
}

/** Lines the rules couldn't place go to the model, which may only choose from the books' own accounts. */
async function aiClassifyLeftovers(db: Database, ctx: LedgerContext, bankLedgerId: string, st: Statement, proposals: Proposal[]) {
  const open = proposals.filter((p) => p.status === 'NEEDS_INPUT' && !p.payload);
  if (!open.length) return;
  const ledgers = await many<{ id: string; name: string; group: string; counterparty_id: string | null }>(db,
    `SELECT l.id, l.name, g.name AS "group", l.counterparty_id FROM ledgers l JOIN ledger_groups g ON g.id = l.group_id
      WHERE l.company_id = $1 AND l.is_active AND l.tax_component IS NULL AND l.id <> $2 ORDER BY (l.counterparty_id IS NULL), l.name LIMIT 300`,
    [ctx.company.id, bankLedgerId]);
  const bills = await many<{ ledger_id: string; refs: string; ref_list: string[] }>(db,
    `SELECT ledger_id, string_agg(bill_ref || '=' || abs(s)::numeric / 100, ', ') AS refs, array_agg(bill_ref) AS ref_list FROM (
       SELECT ledger_id, bill_ref, SUM(amount_minor) AS s FROM bill_allocations WHERE company_id = $1 AND alloc_type IN ('NEW_REF','AGST_REF')
       GROUP BY ledger_id, bill_ref HAVING SUM(amount_minor) <> 0) b GROUP BY ledger_id`, [ctx.company.id]);
  const billsBy = new Map(bills.map((b) => [b.ledger_id, b.refs]));
  // The model may only settle a bill that is actually open on that ledger (exact match, not a substring).
  const openRefs = new Map(bills.map((b) => [b.ledger_id, new Set(b.ref_list)]));
  const keyed: (AccountForAi & { id: string })[] = ledgers.map((l, i) => ({ key: `a${i + 1}`, id: l.id, name: l.name, group: l.group, openBills: billsBy.get(l.id) }));
  const byKey = new Map(keyed.map((k) => [k.key, k]));
  const lineBy = new Map(st.lines.map((l) => [l.lineNo, l]));

  for (let i = 0; i < open.length; i += 60) {
    const chunk = open.slice(i, i + 60);
    const decisions = await classifyBankLines(chunk.map((p) => {
      const l = lineBy.get(p.lineNo)!;
      return { lineNo: l.lineNo, date: l.date, dir: direction(l), amount: fromMinor(lineAmount(l)), narration: l.narration };
    }), keyed, ctx.company);
    for (const d of decisions) {
      const p = proposals.find((x) => x.lineNo === d.line_no);
      const acct = d.counter_key ? byKey.get(d.counter_key) : null;
      if (!p || !acct || p.payload) continue;
      const l = lineBy.get(p.lineNo)!;
      const billRef = d.bill_ref && openRefs.get(acct.id)?.has(d.bill_ref) ? d.bill_ref : null;
      p.payload = bankPayload({ bankLedgerId, isCashBank: (id) => ctx.isCashBank(id) }, l, acct.id, ctx.isCashBank(acct.id) ? null : billRef);
      p.suggestion = { how: 'ai', confidence: d.confidence, reason: d.reason, counterLedgerId: acct.id, counterName: acct.name };
      p.status = d.confidence === 'high' ? 'READY' : 'NEEDS_INPUT';
    }
  }
}

// ---------------------------------------------------------------- Workings (AI)
async function finishWorkings(db: Database, ctx: LedgerContext, doc: DocRow, content: unknown[], opts: DocOptions, userId: string) {
  const ledgers = await many<{ id: string; name: string; group: string }>(db,
    `SELECT l.id, l.name, g.name AS "group" FROM ledgers l JOIN ledger_groups g ON g.id = l.group_id
      WHERE l.company_id = $1 AND l.is_active AND l.tax_component IS NULL ORDER BY l.name LIMIT 400`, [ctx.company.id]);
  const keyed = ledgers.map((l, i) => ({ key: `l${i + 1}`, ...l }));
  const byKey = new Map(keyed.map((k) => [k.key, k.id]));
  const x = await extractWorkings(content, keyed, ctx.company);
  const proposals: Proposal[] = [];
  for (const [i, e] of x.entries.entries()) {
    const draft = {
      lineNo: i + 1, date: e.date, narration: e.narration, ref: null,
      lines: e.lines.map((l) => { const a = parseAmount(l.amount); return { account: l.account_name, side: l.side, amountMinor: a ? decToMinor(a.abs()) : 0n }; }),
    };
    const p = await proposeJournal(db, ctx, draft, opts.date ?? null,
      e.lines.map((l) => (l.ledger_key ? byKey.get(l.ledger_key) ?? null : null)), e.lines.map((l) => l.new_ledger_group));
    // The model's reading of a working is a proposal: a person confirms it.
    proposals.push({ ...p, status: 'NEEDS_INPUT', suggestion: { ...p.suggestion, how: 'ai', confidence: 'medium', reason: 'Proposed from the working; check the accounts and amounts' } });
  }
  if (!proposals.length) throw new AppError('NO_ENTRIES', 422, `No journal entries could be derived from this working.${x.warnings.length ? ` ${x.warnings.join(' ')}` : ''}`);
  await saveAndFinish(db, ctx, doc, proposals, 'WORKINGS', { kind: 'WORKINGS', warnings: x.warnings }, userId);
}

// ---------------------------------------------------------------- Bills and invoices (single voucher)
/** Document kind -> voucher type, and which printed party is ours to book against. */
const BILL_MAP: Record<string, { type: BaseType; partyBlock: 'supplier' | 'buyer'; role: 'received' | 'issued' }> = {
  PURCHASE_BILL: { type: 'PURCHASE', partyBlock: 'supplier', role: 'received' },
  EXPENSE_RECEIPT: { type: 'PURCHASE', partyBlock: 'supplier', role: 'received' },
  CREDIT_NOTE_RECEIVED: { type: 'DEBIT_NOTE', partyBlock: 'supplier', role: 'received' },
  DEBIT_NOTE_RECEIVED: { type: 'CREDIT_NOTE', partyBlock: 'supplier', role: 'received' },
  SALES_INVOICE: { type: 'SALES', partyBlock: 'buyer', role: 'issued' },
  CREDIT_NOTE_ISSUED: { type: 'CREDIT_NOTE', partyBlock: 'buyer', role: 'issued' },
  DEBIT_NOTE_ISSUED: { type: 'DEBIT_NOTE', partyBlock: 'buyer', role: 'issued' },
};

async function processBill(db: Database, ctx: LedgerContext, doc: DocRow, data: Buffer, type: DocType, userId: string) {
  const map = BILL_MAP[type] ?? BILL_MAP.PURCHASE_BILL;
  const bill = await extractBill(data, doc.mime as BillMedia, ctx.company, null, map.role);
  const review = await buildReview(db, ctx, bill, type);
  const draft = await one<{ id: string }>(db,
    `INSERT INTO voucher_drafts (company_id, payload, source, source_ref, created_by) VALUES ($1,$2,'OCR',$3,$4) RETURNING id`,
    [ctx.company.id, JSON.stringify(review.draft), doc.id, userId]);
  await db.query(
    `UPDATE documents SET status = 'NEEDS_REVIEW', doc_type = $8, extraction = $2, validation = $3, matches = $4, draft_id = $5,
            model = $6, prompt_version = $7, updated_at = now() WHERE id = $1`,
    [doc.id, JSON.stringify(bill), JSON.stringify(review.issues), JSON.stringify(review.matches, bigintJson), draft.id, config.model, BILL_PROMPT, type]);
  await autoAcceptBill(db, ctx, doc.id, review, userId);
}

/** Auto-post for a single bill: switched on, party known, every check clean, totals agree, under the limit. */
async function autoAcceptBill(db: Database, ctx: LedgerContext, documentId: string, review: Awaited<ReturnType<typeof buildReview>>, userId: string) {
  const c = await one<{ auto_post: boolean; auto_post_limit_minor: bigint }>(db, `SELECT auto_post, auto_post_limit_minor FROM companies WHERE id = $1`, [ctx.company.id]);
  if (!c.auto_post || !review.draft.counterpartyId) return;
  if (review.issues.some((i) => i.severity !== 'info')) return;
  const printed = dec(review.printedTotal);
  if (!review.matches.recomputedTotal || !printed || new Decimal(review.matches.recomputedTotal).minus(printed).abs().gt(1)) return;
  if (decToMinor(new Decimal(review.matches.recomputedTotal)) > c.auto_post_limit_minor) return;
  try { await acceptDocument(db, ctx.company.id, documentId, { draft: review.draft }, userId); } catch { /* leave it for review */ }
}

interface Matches {
  party: PartyResolution;
  proposedParty: NewParty | null;
  lines: (LineResolution & { description: string })[];
  recomputedTotal: string | null;
  voucherType: BaseType;
  partyRole: 'supplier' | 'customer';
}

/** Turns an extraction into a draft (purchase or sales side) + validation issues + match explanations. */
export async function buildReview(db: Database, ctx: LedgerContext, bill: ParsedBill, docType: DocType | string = 'PURCHASE_BILL') {
  const map = BILL_MAP[docType] ?? (bill.document_type === 'CREDIT_NOTE' ? BILL_MAP.CREDIT_NOTE_RECEIVED : BILL_MAP.PURCHASE_BILL);
  const salesSide = map.type === 'SALES' || map.type === 'CREDIT_NOTE';
  const partyBlock = map.partyBlock === 'buyer' ? bill.buyer : bill.supplier;
  const party = await resolveParty(db, ctx.company.id, { name: partyBlock.name.value, gstin: partyBlock.gstin.value });
  const counterpartyId = party.match?.id ?? null;
  const partyGstin = partyBlock.gstin.value?.toUpperCase() ?? null;
  const proposedParty: NewParty | null = counterpartyId ? null : {
    name: partyBlock.name.value ?? (salesSide ? 'Unknown customer' : 'Unknown supplier'),
    kind: salesSide ? 'CUSTOMER' : 'SUPPLIER',
    gstin: partyGstin && isValidGstin(partyGstin) ? partyGstin : null,
    stateCode: partyGstin && isValidGstin(partyGstin) ? gstinState(partyGstin) : stateCodeFrom(partyBlock.state),
    phone: partyBlock.phone,
    creditDays: bill.due_date && bill.invoice_date.value
      ? Math.max(0, Math.round((Date.parse(bill.due_date) - Date.parse(bill.invoice_date.value)) / 864e5)) : null,
  };

  // On an invoice we issued, the seller is us: use our own GSTIN rather than what the model read off the page.
  const sellerGstin = map.role === 'issued' ? ctx.company.gstin : bill.supplier.gstin.value?.toUpperCase() ?? null;
  const unregistered = !sellerGstin || bill.document_type === 'BILL_OF_SUPPLY';
  const items: NonNullable<VoucherInputRaw['items']> = [];
  const lineMatches: Matches['lines'] = [];
  for (const l of bill.line_items) {
    const m = await resolveLine(db, ctx.company.id, counterpartyId, l.description, l.hsn_sac);
    // Expense-ledger rules are for purchases; a sale books to the item or the Sales ledger.
    const ledgerId = salesSide ? null : m.ledgerId;
    lineMatches.push({ ...m, ledgerId, ledgerName: salesSide ? null : m.ledgerName, description: l.description });
    const amount = lineTaxable(l);
    if (amount === null) continue;
    const qty = dec(l.quantity);
    const useItem = Boolean(m.itemId && qty && qty.gt(0));
    items.push({
      itemId: useItem ? m.itemId : null,
      ledgerId: useItem ? null : ledgerId,
      description: l.description.slice(0, 500),
      qty: useItem ? qty!.toString() : null,
      rate: dec(l.unit_price)?.toString() ?? null,
      amount: amount.toFixed(2),
      gstRate: unregistered ? '0' : lineRate(l, amount),
      hsnSac: l.hsn_sac && /^\d{4,8}$/.test(l.hsn_sac) ? l.hsn_sac : null,
    });
  }
  for (const c of bill.charges) {
    const chargeAmount = dec(c.amount);
    if (!chargeAmount) continue;
    const m = await resolveLine(db, ctx.company.id, counterpartyId, c.label, c.hsn_sac);
    lineMatches.push({ ...m, ledgerId: salesSide ? null : m.ledgerId, ledgerName: salesSide ? null : m.ledgerName, description: c.label });
    items.push({
      ledgerId: salesSide ? null : m.ledgerId, description: c.label, amount: chargeAmount.toFixed(2),
      gstRate: unregistered ? '0' : dec(c.gst_rate_percent)?.toString() ?? '0',
      hsnSac: c.hsn_sac && /^\d{4,8}$/.test(c.hsn_sac) ? c.hsn_sac : null,
    });
  }

  const paidCash = bill.payment.status === 'PAID' && bill.payment.mode === 'CASH';
  const paidBank = bill.payment.status === 'PAID' && bill.payment.mode && bill.payment.mode !== 'CASH';
  const banks = ctx.bankLedgers();
  const ref = bill.invoice_number.value?.slice(0, 16) ?? null;
  const draft: VoucherInputRaw = {
    voucherType: map.type,
    date: bill.invoice_date.value && bill.invoice_date.value <= todayIST() ? bill.invoice_date.value : todayIST(),
    counterpartyId,
    paymentMode: paidCash ? 'CASH' : paidBank && banks.length ? 'BANK' : 'CREDIT',
    bankLedgerId: paidBank && banks.length ? banks[0].id : null,
    partyRefNo: ref,
    partyRefDate: bill.invoice_date.value,
    originalRef: bill.original_invoice_ref,
    dueDate: bill.due_date,
    reverseCharge: !salesSide && bill.reverse_charge === true,
    placeOfSupply: salesSide ? (stateCodeFrom(bill.place_of_supply) ?? (partyGstin && isValidGstin(partyGstin) ? gstinState(partyGstin) : null)) : null,
    items,
    narration: salesSide
      ? `Scanned invoice ${ref ?? ''} to ${bill.buyer.name.value ?? 'customer'}`.trim()
      : `Scanned bill ${ref ?? ''} from ${bill.supplier.name.value ?? 'supplier'}`.trim(),
  };

  // Recompute with our own tax engine; credit mode needs a party, so preview as cash when the party is new.
  let recomputed: Decimal | null = null;
  try {
    const p = await previewVoucher(db, ctx.company.id, { ...draft, paymentMode: counterpartyId ? draft.paymentMode : 'CASH', bankLedgerId: draft.bankLedgerId, confirmWarnings: true });
    recomputed = new Decimal(fromMinor(p.totalMinor));
  } catch { /* incomplete draft; the reviewer will fix it */ }

  const issues = await validateBill(db, ctx.company, bill, counterpartyId, recomputed, { role: map.role, voucherType: map.type });
  const matches: Matches = { party, proposedParty, lines: lineMatches, recomputedTotal: recomputed?.toFixed(2) ?? null, voucherType: map.type, partyRole: salesSide ? 'customer' : 'supplier' };
  return { draft, issues, matches, printedTotal: bill.totals.grand_total.value };
}

/** Printed rate, else inferred from printed tax amounts (snapped to a known slab), else 0. */
function lineRate(l: ParsedBill['line_items'][number], taxable: Decimal): string {
  const printed = dec(l.gst_rate_percent);
  if (printed) return printed.toString();
  const tax = [l.cgst, l.sgst, l.igst].reduce((s, x) => s.plus(dec(x) ?? 0), new Decimal(0));
  if (tax.gt(0) && taxable.gt(0)) {
    const pct = tax.div(taxable).times(100);
    const slab = [...KNOWN_GST_RATES_PPM].map((p) => p / 10_000).find((r) => pct.minus(r).abs().lt(0.2));
    if (slab !== undefined) return String(slab);
  }
  return '0';
}

export async function acceptDocument(db: Database, companyId: string, documentId: string, body: { draft: VoucherInputRaw; newParty?: NewParty | null; confirmWarnings?: boolean }, userId: string) {
  const doc = await maybeOne<{ id: string; status: string; draft_id: string | null; extraction: ParsedBill | null; doc_type: string | null }>(db,
    `SELECT id, status, draft_id, extraction, doc_type FROM documents WHERE id = $1 AND company_id = $2`, [documentId, companyId]);
  if (!doc) throw notFound('Document');
  if (doc.status === 'ACCEPTED') throw new AppError('ALREADY_ACCEPTED', 409, 'This document has already been posted');
  let draft = { ...body.draft };
  const salesSide = draft.voucherType === 'SALES' || draft.voucherType === 'CREDIT_NOTE';
  if (!draft.counterpartyId && body.newParty) {
    const created = await createParty(db, companyId, { ...body.newParty, kind: salesSide ? 'CUSTOMER' : 'SUPPLIER' }, userId, 'OCR');
    draft = { ...draft, counterpartyId: created.id };
  }
  if (doc.draft_id) await db.query(`UPDATE voucher_drafts SET payload = $2, updated_at = now() WHERE id = $1`, [doc.draft_id, JSON.stringify(draft)]);
  const posted = await postVoucher(db, companyId, { ...draft, confirmWarnings: Boolean(body.confirmWarnings) },
    { source: 'OCR', idempotencyKey: await liveKey(db, companyId, `doc:${documentId}`), userId, draftId: doc.draft_id });

  // Learn from the reviewer: printed party name -> party; line description -> item / ledger.
  const printed = salesSide ? doc.extraction?.buyer.name.value : doc.extraction?.supplier.name.value;
  if (printed && draft.counterpartyId) await learnPartyAlias(db, companyId, printed, draft.counterpartyId);
  if (draft.counterpartyId) {
    for (const it of draft.items ?? []) {
      if (it.description) await learnLine(db, companyId, draft.counterpartyId, it.description, it.itemId ?? null, it.ledgerId ?? null);
    }
  }
  await db.query(`UPDATE documents SET status = 'ACCEPTED', voucher_id = $2, updated_at = now() WHERE id = $1`, [documentId, posted.id]);
  return posted;
}

/**
 * The idempotency key for posting from a document. A double click must find the voucher already posted, but
 * once that voucher has been reversed (say, to read the bill again and post it corrected) a new key is needed,
 * or posting would quietly hand back the reversed voucher and put nothing in the books.
 */
export async function liveKey(db: Db, companyId: string, base: string): Promise<string> {
  const used = await many<{ key: string; reversed: boolean }>(db,
    `SELECT v.idempotency_key AS key, EXISTS (SELECT 1 FROM vouchers r WHERE r.reverses_voucher_id = v.id) AS reversed
       FROM vouchers v WHERE v.company_id = $1 AND (v.idempotency_key = $2 OR v.idempotency_key LIKE $2 || ':redo%')`,
    [companyId, base]);
  const live = used.find((u) => !u.reversed);
  if (live) return live.key;
  return used.length ? `${base}:redo${used.length}` : base;
}

export async function rejectDocument(db: Database, companyId: string, documentId: string) {
  const doc = await maybeOne<{ draft_id: string | null; status: string }>(db, `SELECT draft_id, status FROM documents WHERE id = $1 AND company_id = $2`, [documentId, companyId]);
  if (!doc) throw notFound('Document');
  if (doc.status === 'ACCEPTED') throw new AppError('ALREADY_ACCEPTED', 409, 'Posted entries must be reversed from the Day Book');
  await db.query(`UPDATE documents SET status = 'REJECTED', updated_at = now() WHERE id = $1`, [documentId]);
  await db.query(`UPDATE document_entries SET status = 'SKIPPED', updated_at = now() WHERE document_id = $1 AND status IN ('READY','NEEDS_INPUT')`, [documentId]);
  if (doc.draft_id) await db.query(`UPDATE voucher_drafts SET status = 'DISCARDED', updated_at = now() WHERE id = $1`, [doc.draft_id]);
}

/** Re-run a document with new choices (bank account, register type, forced document type). Posted lines are kept. */
export async function reprocessDocument(db: Database, companyId: string, documentId: string, options: DocOptions) {
  const doc = await maybeOne<{ options: DocOptions; status: string; voucher_id: string | null }>(db,
    `SELECT options, status, voucher_id FROM documents WHERE id = $1 AND company_id = $2`, [documentId, companyId]);
  if (!doc) throw notFound('Document');
  // Reading it twice at once would pay for two AI calls and leave duplicate entries.
  if (active.has(documentId)) throw new AppError('DOCUMENT_BUSY', 409, 'This document is still being read. Try again once it finishes.');
  if (doc.voucher_id && !(await maybeOne(db, `SELECT 1 FROM vouchers WHERE reverses_voucher_id = $1`, [doc.voucher_id]))) {
    throw new AppError('DOCUMENT_POSTED', 409, 'This bill is already in the books. Reverse its voucher from the Day Book first, then read it again.');
  }
  const merged = { ...(doc.options ?? {}), ...options };
  await db.query(`UPDATE documents SET options = $2, status = 'RECEIVED', updated_at = now() WHERE id = $1`, [documentId, JSON.stringify(merged)]);
  enqueue(db, documentId);
}

/** Deletes a document, its unposted entries and its file. Refused while anything posted from it is still live in the books. */
export async function deleteDocument(db: Database, companyId: string, documentId: string, userId: string) {
  const doc = await maybeOne<{ status: string; file_name: string; storage_key: string; draft_id: string | null }>(db,
    `SELECT status, file_name, storage_key, draft_id FROM documents WHERE id = $1 AND company_id = $2`, [documentId, companyId]);
  if (!doc) throw notFound('Document');
  if (doc.status === 'RECEIVED' || doc.status === 'PROCESSING') throw new AppError('DOCUMENT_BUSY', 409, 'This document is still being read. Delete it once it finishes.');
  const live = await many<{ voucher_no: string }>(db,
    `SELECT v.voucher_no FROM vouchers v
      WHERE v.company_id = $1
        AND v.id IN (SELECT voucher_id FROM documents WHERE id = $2 UNION SELECT voucher_id FROM document_entries WHERE document_id = $2)
        AND NOT EXISTS (SELECT 1 FROM vouchers r WHERE r.reverses_voucher_id = v.id)
      ORDER BY v.chain_seq`, [companyId, documentId]);
  if (live.length) {
    throw new AppError('DOCUMENT_POSTED', 409,
      `Entries from this document are in the books (No. ${live.map((v) => v.voucher_no).join(', ')}). Reverse them from the Day Book first, then delete it.`);
  }
  await db.transaction(async (tx) => {
    await tx.query(`DELETE FROM document_entries WHERE document_id = $1`, [documentId]);
    await tx.query(`DELETE FROM documents WHERE id = $1`, [documentId]);
    if (doc.draft_id) await tx.query(`UPDATE voucher_drafts SET status = 'DISCARDED', updated_at = now() WHERE id = $1 AND status = 'OPEN'`, [doc.draft_id]);
    await audit(tx, companyId, userId, 'MANUAL', 'DELETE', 'document', documentId, { fileName: doc.file_name, status: doc.status }, null);
  });
  // The same file can be uploaded to another company; keep it while any document still points at it.
  if (!(await maybeOne(db, `SELECT 1 FROM documents WHERE storage_key = $1`, [doc.storage_key]))) {
    fs.rmSync(documentFilePath(doc.storage_key), { force: true });
  }
}

export function documentFilePath(storageKey: string) {
  return path.join(config.uploadDir, path.basename(storageKey));
}
