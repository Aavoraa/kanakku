import fs from 'node:fs';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { many, one, type Db } from '../db/client';
import { config } from '../config';
import { invalid } from '../lib/errors';
import { addDays, fyEnd, fyStart, todayIST } from '../lib/dates';
import { formatINR } from '../lib/money';
import { audit, verifyChain } from '../ledger/post';
import { profitAndLoss } from '../reports/financials';
import { listBackups } from '../db/backup';
import { deleteDocument } from '../ai/documents';
import { complianceItems } from '../compliance/service';

/**
 * Housekeeping for the books: a health check, clearing old rejected uploads, and closing a financial year
 * (checks, then lock it so nothing more can be posted into it). Backups live in db/backup.ts.
 */

export type CheckLevel = 'ok' | 'warn' | 'error' | 'info';
export interface Check { id: string; label: string; level: CheckLevel; detail: string; fix?: string }

/** Every check over this company's books, with what to do about anything found. */
export async function healthCheck(db: Db, companyId: string, opts: { isAdmin: boolean }): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);

  const chain = await verifyChain(db, companyId);
  add(chain.ok
    ? { id: 'chain', label: 'Voucher hash chain', level: 'ok', detail: `${chain.checked} vouchers verified; nothing was edited outside the posting engine.` }
    : { id: 'chain', label: 'Voucher hash chain', level: 'error', detail: `Broken at voucher ${chain.brokenAt.voucherNo}: the books were changed outside Kannaku AI.`, fix: 'Restore the latest backup from before the change, or contact support.' });

  const total = await one<{ s: bigint }>(db, `SELECT COALESCE(SUM(amount_minor), 0)::bigint AS s FROM ledger_entries WHERE company_id = $1`, [companyId]);
  add(total.s === 0n
    ? { id: 'balance', label: 'Debits equal credits', level: 'ok', detail: 'The trial balance agrees.' }
    : { id: 'balance', label: 'Debits equal credits', level: 'error', detail: `Debits and credits differ by ₹${formatINR(total.s < 0n ? -total.s : total.s)}.`, fix: 'Restore the latest good backup.' });

  // Cash cannot go below zero on any day; a negative day means a payment was dated before the cash came in.
  const negCash = await many<{ name: string; d: string; bal: bigint }>(db,
    `WITH daily AS (
       SELECT e.ledger_id, e.voucher_date, SUM(e.amount_minor) AS amt FROM ledger_entries e
         JOIN ledgers l ON l.id = e.ledger_id JOIN ledger_groups g ON g.id = l.group_id
        WHERE e.company_id = $1 AND g.path ~ '*.cash_in_hand.*' GROUP BY e.ledger_id, e.voucher_date),
     running AS (SELECT ledger_id, voucher_date, SUM(amt) OVER (PARTITION BY ledger_id ORDER BY voucher_date) AS bal FROM daily),
     worst AS (SELECT DISTINCT ON (ledger_id) ledger_id, voucher_date, bal FROM running WHERE bal < 0 ORDER BY ledger_id, bal, voucher_date)
     SELECT l.name, w.voucher_date::text AS d, w.bal::bigint AS bal FROM worst w JOIN ledgers l ON l.id = w.ledger_id ORDER BY l.name`, [companyId]);
  add(negCash.length === 0
    ? { id: 'cash', label: 'Cash never negative', level: 'ok', detail: 'Cash and petty cash stay at or above zero on every day.' }
    : { id: 'cash', label: 'Cash never negative', level: 'warn', detail: negCash.map((n) => `${n.name} is ₹${formatINR(-n.bal)} below zero on ${n.d}`).join('; '),
      fix: 'Check the dates of payments around that day; a receipt or withdrawal is probably missing or dated later.' });

  const negStock = await many<{ name: string; d: string; q: string }>(db,
    `WITH daily AS (SELECT item_id, voucher_date, SUM(qty) AS q FROM inventory_entries WHERE company_id = $1 GROUP BY item_id, voucher_date),
     running AS (SELECT item_id, voucher_date, SUM(q) OVER (PARTITION BY item_id ORDER BY voucher_date) AS bal FROM daily),
     worst AS (SELECT DISTINCT ON (item_id) item_id, voucher_date, bal FROM running WHERE bal < 0 ORDER BY item_id, bal, voucher_date)
     SELECT i.name, w.voucher_date::text AS d, w.bal::text AS q FROM worst w JOIN stock_items i ON i.id = w.item_id WHERE NOT i.allow_negative ORDER BY i.name`, [companyId]);
  add(negStock.length === 0
    ? { id: 'stock', label: 'Stock never negative', level: 'ok', detail: 'No item was sold before it was in stock.' }
    : { id: 'stock', label: 'Stock never negative', level: 'warn', detail: negStock.map((n) => `${n.name} at ${n.q} on ${n.d}`).join('; '), fix: 'A purchase is probably missing or dated after the sale.' });

  const stuck = await one<{ n: bigint }>(db,
    `SELECT COUNT(*)::bigint AS n FROM documents WHERE company_id = $1 AND status IN ('RECEIVED','PROCESSING') AND updated_at < now() - interval '1 hour'`, [companyId]);
  const failed = await one<{ n: bigint }>(db, `SELECT COUNT(*)::bigint AS n FROM documents WHERE company_id = $1 AND status = 'FAILED'`, [companyId]);
  const open = await one<{ n: bigint }>(db,
    `SELECT (SELECT COUNT(*) FROM documents WHERE company_id = $1 AND status = 'NEEDS_REVIEW')
          + (SELECT COUNT(*) FROM document_entries WHERE company_id = $1 AND status IN ('READY','NEEDS_INPUT')) AS n`, [companyId]);
  add(stuck.n > 0n
    ? { id: 'docs', label: 'Uploaded documents', level: 'warn', detail: `${stuck.n} document(s) have been "reading" for over an hour.`, fix: 'Open Documents and press Retry on them (the server may have been stopped mid-way).' }
    : { id: 'docs', label: 'Uploaded documents', level: open.n > 0n || failed.n > 0n ? 'info' : 'ok',
      detail: `${open.n} waiting for your review, ${failed.n} could not be read.` });

  const noState = await one<{ n: bigint }>(db, `SELECT COUNT(*)::bigint AS n FROM counterparties WHERE company_id = $1 AND status <> 'INACTIVE' AND gstin IS NULL AND state_code IS NULL`, [companyId]);
  add(noState.n === 0n
    ? { id: 'parties', label: 'Party states', level: 'ok', detail: 'Every party has a GSTIN or a state, so GST is split correctly.' }
    : { id: 'parties', label: 'Party states', level: 'warn', detail: `${noState.n} part${noState.n === 1n ? 'y has' : 'ies have'} neither a GSTIN nor a state; sales to them are treated as within your state.`, fix: 'Edit them in Masters → Parties.' });

  const noHsn = await one<{ n: bigint }>(db,
    `SELECT COUNT(DISTINCT i.id)::bigint AS n FROM stock_items i JOIN inventory_entries ie ON ie.item_id = i.id WHERE i.company_id = $1 AND i.hsn_sac IS NULL AND ie.qty < 0`, [companyId]);
  if (noHsn.n > 0n) add({ id: 'hsn', label: 'HSN codes', level: 'info', detail: `${noHsn.n} item(s) that have been sold have no HSN code; GSTR-1 needs an HSN summary.`, fix: 'Add them in Masters → Items.' });

  // A financial year that ended over three months ago and is still open for posting.
  const co = await one<{ books_from: string; lock_date: string | null; fy_start_month: number }>(db,
    `SELECT books_from::text, lock_date::text, fy_start_month FROM companies WHERE id = $1`, [companyId]);
  const lastEnded = addDays(fyStart(todayIST(), co.fy_start_month), -1);
  if (lastEnded >= co.books_from && addDays(lastEnded, 92) < todayIST() && (!co.lock_date || co.lock_date < lastEnded)) {
    add({ id: 'close', label: 'Year closing', level: 'info', detail: `The year ended ${lastEnded} is still open for posting.`, fix: 'Close it below once its returns are filed.' });
  }

  if (opts.isAdmin) {
    const newest = listBackups(config.backupDir).at(-1);
    const age = newest ? (Date.now() - fs.statSync(path.join(config.backupDir, newest)).mtimeMs) / 864e5 : Infinity;
    add(age <= 2
      ? { id: 'backup', label: 'Backups', level: 'ok', detail: `Latest backup ${newest}.` }
      : { id: 'backup', label: 'Backups', level: 'warn', detail: newest ? `The latest backup is ${Math.floor(age)} days old.` : 'No backup has been made yet.', fix: 'Press Back up now, and keep a copy off this computer.' });
  }
  return checks;
}

/** Uploads that were rejected or could not be read, older than `days`, with nothing from them in the books. */
export async function oldDocuments(db: Db, companyId: string, days = 90) {
  return many<{ id: string; fileName: string; status: string; createdAt: string }>(db,
    `SELECT d.id, d.file_name AS "fileName", d.status, d.created_at::text AS "createdAt" FROM documents d
      WHERE d.company_id = $1 AND d.status IN ('REJECTED','FAILED') AND d.created_at < now() - ($2::int * interval '1 day')
        AND NOT EXISTS (SELECT 1 FROM vouchers v WHERE v.id = d.voucher_id)
        AND NOT EXISTS (SELECT 1 FROM document_entries e WHERE e.document_id = d.id AND e.voucher_id IS NOT NULL)
      ORDER BY d.created_at`, [companyId, days]);
}

/** Deletes the listed old uploads (each still checked by deleteDocument). Returns how many went. */
export async function clearOldDocuments(db: PGlite, companyId: string, ids: unknown, userId: string) {
  if (!Array.isArray(ids) || ids.some((i) => typeof i !== 'string')) throw invalid('Choose the documents to delete');
  const allowed = new Set((await oldDocuments(db, companyId)).map((d) => d.id));
  let deleted = 0;
  for (const id of ids as string[]) {
    if (!allowed.has(id)) continue;
    await deleteDocument(db, companyId, id, userId);
    deleted++;
  }
  return { deleted };
}

/** What closing the financial year ending `end` involves: blockers that stop it, warnings, and the year's result. */
export async function yearClosePreview(db: Db, companyId: string, end: string) {
  const co = await one<{ books_from: string; lock_date: string | null; fy_start_month: number }>(db,
    `SELECT books_from::text, lock_date::text, fy_start_month FROM companies WHERE id = $1`, [companyId]);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(end) || fyEnd(end, co.fy_start_month) !== end) throw invalid('Choose the last day of a financial year');
  if (end >= todayIST()) throw invalid('A year can be closed only after it has ended');
  const start = fyStart(end, co.fy_start_month);
  const blockers: string[] = [];
  const warnings: string[] = [];

  const chain = await verifyChain(db, companyId);
  if (!chain.ok) blockers.push(`The voucher hash chain is broken at ${chain.brokenAt.voucherNo}.`);
  const openEntries = await one<{ n: bigint }>(db,
    `SELECT COUNT(*)::bigint AS n FROM document_entries WHERE company_id = $1 AND status IN ('READY','NEEDS_INPUT') AND entry_date <= $2`, [companyId, end]);
  if (openEntries.n > 0n) blockers.push(`${openEntries.n} uploaded statement / sheet line(s) dated in this year are still waiting to be posted or skipped (Documents).`);
  const openBills = await one<{ n: bigint }>(db,
    `SELECT COUNT(*)::bigint AS n FROM documents d JOIN voucher_drafts vd ON vd.id = d.draft_id
      WHERE d.company_id = $1 AND d.status = 'NEEDS_REVIEW' AND (vd.payload->>'date') <= $2`, [companyId, end]);
  if (openBills.n > 0n) blockers.push(`${openBills.n} uploaded bill(s) dated in this year are still waiting for review (Documents).`);

  // Returns for the year not marked filed: a warning, since they may have been filed outside the app.
  const due = await complianceItems(db, companyId, start, addDays(end, 300));
  const unfiled = due.filter((i) => i.category !== 'TASK' && i.category !== 'ASSET' && i.periodTo <= end && i.status !== 'DONE');
  if (unfiled.length) warnings.push(`${unfiled.length} return(s) or payment(s) for this year are not marked done in the compliance calendar: ${unfiled.slice(0, 5).map((i) => `${i.title} ${i.periodLabel}`).join(', ')}${unfiled.length > 5 ? '…' : ''}.`);
  if (co.lock_date && co.lock_date >= end) warnings.push(`The books are already locked up to ${co.lock_date}.`);

  const pl = await profitAndLoss(db, companyId, start < co.books_from ? co.books_from : start, end);
  return {
    start, end, blockers, warnings, alreadyLocked: Boolean(co.lock_date && co.lock_date >= end),
    netProfitMinor: pl.netProfitMinor, closingStockMinor: pl.closingStockMinor,
  };
}

/**
 * Closes the year: refuses while there are blockers, then locks the books up to its last day. The profit carries
 * into the next year by itself (reports fold earlier years' profit into the Profit & Loss A/c), and closing stock
 * becomes next year's opening stock; nothing has to be posted.
 */
export async function closeYear(db: PGlite, companyId: string, end: string, userId: string) {
  const p = await yearClosePreview(db, companyId, end);
  if (p.blockers.length) throw invalid(`The year cannot be closed yet: ${p.blockers.join(' ')}`);
  const before = await one<{ lock_date: string | null }>(db, `SELECT lock_date::text FROM companies WHERE id = $1`, [companyId]);
  if (!p.alreadyLocked) await db.query(`UPDATE companies SET lock_date = $2 WHERE id = $1`, [companyId, end]);
  await audit(db, companyId, userId, 'MANUAL', 'CLOSE_YEAR', 'company', companyId, { lockDate: before.lock_date },
    { lockDate: p.alreadyLocked ? before.lock_date : end, netProfit: p.netProfitMinor.toString(), closingStock: p.closingStockMinor.toString() });
  return { ...p, lockDate: p.alreadyLocked ? before.lock_date : end };
}
