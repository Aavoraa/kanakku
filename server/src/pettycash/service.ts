import { many, maybeOne, one, type Db, type Database } from '../db/client';
import { AppError, invalid, notFound } from '../lib/errors';
import { formatINR, fromMinor, toMinor } from '../lib/money';
import { todayIST } from '../lib/dates';
import { LedgerContext } from '../ledger/context';
import { createLedger, groupByCode } from '../ledger/masters';
import { audit, postVoucher, type PostedVoucher } from '../ledger/post';
import { postExpense, type ExpenseInput } from '../ledger/expense';
import { ledgerStatement } from '../reports/registers';

/**
 * Petty cash on the imprest system: a Cash-in-Hand ledger with a fixed float kept by a custodian. Small expenses
 * are paid from it; it is topped up back to the float from the bank or main cash; the cash is counted note by note
 * and any shortage or excess is posted. Every movement is an ordinary voucher through the posting engine.
 */

/** Notes and coins in circulation, in rupees. */
export const DENOMINATIONS = [2000, 500, 200, 100, 50, 20, 10, 5, 2, 1] as const;
/** Below this share of the float, the bell asks for a top-up. */
const LOW_SHARE = 25n;

interface BoxRow { id: string; ledger_id: string; name: string; custodian: string | null; float_minor: bigint; voucher_limit_minor: bigint }

const money = (v: unknown, label: string): bigint => {
  const s = String(v ?? '').replace(/,/g, '').trim();
  if (!/^\d+(\.\d+)?$/.test(s) || Number(s) <= 0) throw invalid(`Enter the ${label} in rupees, like 10000`);
  return toMinor(s);
};
const isoDate = (v: unknown, label = 'date') => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw invalid(`Enter the ${label}`);
  return v;
};

async function box(db: Db, companyId: string, boxId: string): Promise<BoxRow> {
  const b = await maybeOne<BoxRow>(db,
    `SELECT b.id, b.ledger_id, l.name, b.custodian, b.float_minor, b.voucher_limit_minor
       FROM petty_cash_boxes b JOIN ledgers l ON l.id = b.ledger_id WHERE b.id = $1 AND b.company_id = $2 AND b.active`, [boxId, companyId]);
  if (!b) throw notFound('Petty cash box');
  return b;
}

/** Book balance at the end of `asOf`. */
async function balance(db: Db, ledgerId: string, asOf = '9999-12-31'): Promise<bigint> {
  return (await one<{ s: bigint }>(db, `SELECT COALESCE(SUM(amount_minor), 0)::bigint AS s FROM ledger_entries WHERE ledger_id = $1 AND voucher_date <= $2`, [ledgerId, asOf])).s;
}

/**
 * The least the box holds on any day from `from` on. Cash cannot go below zero, so a payment dated `from` can be
 * at most this much (later payments already rely on the rest).
 */
async function lowestFrom(db: Db, ledgerId: string, from: string): Promise<bigint> {
  const atStart = await balance(db, ledgerId, from);
  const r = await one<{ low: bigint | null }>(db,
    `WITH daily AS (SELECT voucher_date, SUM(amount_minor) AS d FROM ledger_entries WHERE ledger_id = $1 AND voucher_date > $2 GROUP BY voucher_date),
          running AS (SELECT SUM(d) OVER (ORDER BY voucher_date) AS run FROM daily)
     SELECT MIN(run)::bigint AS low FROM running`, [ledgerId, from]);
  const laterDip = r.low !== null && r.low < 0n ? r.low : 0n;
  return atStart + laterDip;
}

export interface NewBox { name?: string; custodian?: string | null; floatAmount?: string; voucherLimit?: string; fundFromLedgerId?: string | null; date?: string }

export async function createBox(db: Database, companyId: string, b: NewBox, userId: string) {
  const name = (b.name ?? '').trim() || 'Petty Cash';
  const floatMinor = money(b.floatAmount, 'float');
  const limitMinor = b.voucherLimit ? money(b.voucherLimit, 'limit per payment') : 500000n;
  if (limitMinor > floatMinor) throw invalid('The limit per payment cannot be more than the float');
  // Check the funding source before creating anything, so a bad choice leaves no half-made box behind.
  if (b.fundFromLedgerId && !(await LedgerContext.load(db, companyId)).isCashBank(b.fundFromLedgerId)) {
    throw invalid('The float is funded from a bank or cash ledger');
  }
  if (b.date !== undefined) isoDate(b.date);
  const group = await groupByCode(db, companyId, 'CASH_IN_HAND');
  const ledger = await createLedger(db, companyId, { name, groupId: group.id }, userId);
  const row = await one<{ id: string }>(db,
    `INSERT INTO petty_cash_boxes (company_id, ledger_id, custodian, float_minor, voucher_limit_minor, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [companyId, ledger.id, b.custodian?.trim().slice(0, 120) || null, floatMinor, limitMinor, userId]);
  await audit(db, companyId, userId, 'MANUAL', 'CREATE', 'petty_cash_box', row.id, null, { name, custodian: b.custodian, float: fromMinor(floatMinor), limit: fromMinor(limitMinor) });
  let funded: PostedVoucher | null = null;
  if (b.fundFromLedgerId) {
    funded = await topUp(db, companyId, row.id, { date: b.date ?? todayIST(), fromLedgerId: b.fundFromLedgerId }, { idempotencyKey: `petty-fund:${row.id}`, userId });
  }
  return { id: row.id, ledgerId: ledger.id, funded };
}

export async function updateBox(db: Database, companyId: string, boxId: string, p: { custodian?: string | null; floatAmount?: string; voucherLimit?: string }, userId: string) {
  const b = await box(db, companyId, boxId);
  const floatMinor = p.floatAmount !== undefined ? money(p.floatAmount, 'float') : b.float_minor;
  const limitMinor = p.voucherLimit !== undefined ? money(p.voucherLimit, 'limit per payment') : b.voucher_limit_minor;
  if (limitMinor > floatMinor) throw invalid('The limit per payment cannot be more than the float');
  const custodian = p.custodian === undefined ? b.custodian : p.custodian?.trim().slice(0, 120) || null;
  await db.query(`UPDATE petty_cash_boxes SET custodian = $2, float_minor = $3, voucher_limit_minor = $4 WHERE id = $1`, [boxId, custodian, floatMinor, limitMinor]);
  await audit(db, companyId, userId, 'MANUAL', 'UPDATE', 'petty_cash_box', boxId,
    { custodian: b.custodian, float: fromMinor(b.float_minor), limit: fromMinor(b.voucher_limit_minor) },
    { custodian, float: fromMinor(floatMinor), limit: fromMinor(limitMinor) });
}

export async function listBoxes(db: Db, companyId: string) {
  const boxes = await many<BoxRow & { last_count: string | null; last_count_diff: bigint | null }>(db,
    `SELECT b.id, b.ledger_id, l.name, b.custodian, b.float_minor, b.voucher_limit_minor,
            (SELECT count_date::text FROM petty_cash_counts c WHERE c.box_id = b.id ORDER BY count_date DESC, created_at DESC LIMIT 1) AS last_count,
            (SELECT counted_minor - book_minor FROM petty_cash_counts c WHERE c.box_id = b.id ORDER BY count_date DESC, created_at DESC LIMIT 1) AS last_count_diff
       FROM petty_cash_boxes b JOIN ledgers l ON l.id = b.ledger_id WHERE b.company_id = $1 AND b.active ORDER BY l.name`, [companyId]);
  const out = [];
  for (const b of boxes) {
    const bal = await balance(db, b.ledger_id);
    out.push({
      id: b.id, ledgerId: b.ledger_id, name: b.name, custodian: b.custodian, floatMinor: b.float_minor, voucherLimitMinor: b.voucher_limit_minor,
      balanceMinor: bal, topUpMinor: bal < b.float_minor ? b.float_minor - bal : 0n, low: bal * 100n < b.float_minor * LOW_SHARE,
      lastCount: b.last_count, lastCountDiffMinor: b.last_count_diff,
    });
  }
  return out;
}

export interface PettyExpense extends Omit<ExpenseInput, 'paidFromLedgerId'> { confirmWarnings?: boolean }

/** A payment out of petty cash. Refused if the box does not hold the money on that date (and every later one). */
export async function recordExpense(db: Database, companyId: string, boxId: string, e: PettyExpense, opts: { idempotencyKey: string; userId: string }) {
  const b = await box(db, companyId, boxId);
  isoDate(e.date);
  const amountMinor = money(e.amount, 'amount paid');
  const available = await lowestFrom(db, b.ledger_id, e.date);
  if (amountMinor > available) {
    throw new AppError('PETTY_CASH_SHORT', 422,
      `${b.name} has only ₹${formatINR(available > 0n ? available : 0n)} available on ${e.date}. Top it up first.`);
  }
  const extra = amountMinor > b.voucher_limit_minor
    ? [{ code: 'PETTY_LIMIT', message: `This is more than the petty cash limit of ₹${formatINR(b.voucher_limit_minor)} per payment.` }] : [];
  return postExpense(db, companyId, { ...e, paidFromLedgerId: b.ledger_id },
    { idempotencyKey: opts.idempotencyKey, userId: opts.userId, confirmWarnings: e.confirmWarnings, extraWarnings: extra });
}

/** Imprest top-up: brings the box back to its float (or by the amount given) from the bank or main cash. */
export async function topUp(db: Database, companyId: string, boxId: string, t: { date: string; fromLedgerId: string; amount?: string | null },
  opts: { idempotencyKey: string; userId: string }) {
  const b = await box(db, companyId, boxId);
  const date = isoDate(t.date);
  const ctx = await LedgerContext.load(db, companyId);
  if (t.fromLedgerId === b.ledger_id) throw invalid('Choose the bank or main cash ledger the money comes from');
  if (!ctx.isCashBank(t.fromLedgerId)) throw invalid('A top-up comes from a bank or cash ledger');
  const bal = await balance(db, b.ledger_id, date);
  const amountMinor = t.amount ? money(t.amount, 'top-up amount') : b.float_minor - bal;
  if (amountMinor <= 0n) throw new AppError('PETTY_CASH_FULL', 422, `${b.name} already holds its float of ₹${formatINR(b.float_minor)}.`);
  const amount = fromMinor(amountMinor);
  return postVoucher(db, companyId, {
    voucherType: 'CONTRA', date, narration: `Petty cash top-up to ${b.name}${b.custodian ? ` (${b.custodian})` : ''}`,
    entries: [{ ledgerId: b.ledger_id, side: 'DR', amount }, { ledgerId: t.fromLedgerId, side: 'CR', amount }],
  }, { source: 'MANUAL', idempotencyKey: opts.idempotencyKey, userId: opts.userId });
}

const SHORT_EXCESS = 'Petty Cash Short / Excess';

/** The ledger shortages and excesses are posted to (created under Indirect Expenses the first time). */
async function shortExcessLedger(db: Database, companyId: string, userId: string): Promise<string> {
  const l = await maybeOne<{ id: string }>(db, `SELECT id FROM ledgers WHERE company_id = $1 AND lower(name) = lower($2)`, [companyId, SHORT_EXCESS]);
  if (l) return l.id;
  const group = await groupByCode(db, companyId, 'INDIRECT_EXPENSES');
  return (await createLedger(db, companyId, { name: SHORT_EXCESS, groupId: group.id }, userId)).id;
}

export interface CountInput { date: string; notes: Record<string, number | string>; coins?: string | null; remarks?: string | null; postDifference?: boolean }

/**
 * Records a physical count against the book balance at the end of that day. With postDifference, a shortage is
 * paid out to "Petty Cash Short / Excess" and an excess received from it, so the books match the cash.
 */
export async function countCash(db: Database, companyId: string, boxId: string, c: CountInput, opts: { idempotencyKey: string; userId: string }) {
  const b = await box(db, companyId, boxId);
  const date = isoDate(c.date);
  if (date > todayIST()) throw invalid('A count cannot be dated in the future');
  const notes: Record<string, number> = {};
  let counted = 0n;
  for (const d of DENOMINATIONS) {
    const raw = c.notes?.[String(d)];
    const n = raw === undefined || raw === '' ? 0 : Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 100000) throw invalid(`Number of ₹${d} is not valid`);
    if (n) { notes[String(d)] = n; counted += BigInt(d) * 100n * BigInt(n); }
  }
  const coinsMinor = c.coins ? toMinor(String(c.coins).replace(/,/g, '')) : 0n;
  if (coinsMinor < 0n) throw invalid('Loose coins cannot be negative');
  counted += coinsMinor;
  const book = await balance(db, b.ledger_id, date);
  const diff = counted - book;

  let adjustment: PostedVoucher | null = null;
  if (c.postDifference && diff !== 0n) {
    const other = await shortExcessLedger(db, companyId, opts.userId);
    const amount = fromMinor(diff < 0n ? -diff : diff);
    adjustment = await postVoucher(db, companyId, diff < 0n
      ? { voucherType: 'PAYMENT', date, narration: `Petty cash shortage found on counting ${b.name}`, entries: [{ ledgerId: other, side: 'DR', amount }, { ledgerId: b.ledger_id, side: 'CR', amount }] }
      : { voucherType: 'RECEIPT', date, narration: `Petty cash excess found on counting ${b.name}`, entries: [{ ledgerId: b.ledger_id, side: 'DR', amount }, { ledgerId: other, side: 'CR', amount }] },
    { source: 'MANUAL', idempotencyKey: opts.idempotencyKey, userId: opts.userId });
  }
  const row = await one<{ id: string }>(db,
    `INSERT INTO petty_cash_counts (box_id, company_id, count_date, denominations, coins_minor, counted_minor, book_minor, adjustment_voucher_id, remarks, counted_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [b.id, companyId, date, JSON.stringify(notes), coinsMinor, counted, book, adjustment?.id ?? null, c.remarks?.trim().slice(0, 500) || null, opts.userId]);
  await audit(db, companyId, opts.userId, 'MANUAL', 'COUNT', 'petty_cash_box', b.id, null,
    { countId: row.id, date, counted: fromMinor(counted), book: fromMinor(book), difference: fromMinor(diff), adjustment: adjustment?.voucherNo ?? null });
  return { id: row.id, countedMinor: counted, bookMinor: book, differenceMinor: diff, adjustment };
}

/** Petty cash book for a period: every movement with a running balance, spending by head, and the counts. */
export async function pettyCashBook(db: Db, companyId: string, boxId: string, from: string, to: string) {
  const b = await box(db, companyId, boxId);
  const statement = await ledgerStatement(db, companyId, b.ledger_id, from, to);
  // What was spent on, net of reversals: the other (non cash/bank) lines of vouchers that touch this box.
  const byHead = await many<{ ledger: string; amountMinor: bigint }>(db,
    `SELECT l.name AS ledger, SUM(e.amount_minor)::bigint AS "amountMinor"
       FROM ledger_entries e JOIN ledgers l ON l.id = e.ledger_id JOIN ledger_groups g ON g.id = l.group_id
      WHERE e.company_id = $1 AND e.voucher_date BETWEEN $3 AND $4 AND e.ledger_id <> $2
        AND NOT (g.path ~ '*.bank_accounts|cash_in_hand|bank_od.*')
        AND e.voucher_id IN (SELECT voucher_id FROM ledger_entries WHERE ledger_id = $2)
      GROUP BY l.name HAVING SUM(e.amount_minor) <> 0 ORDER BY 2 DESC`, [companyId, b.ledger_id, from, to]);
  const counts = await many(db,
    `SELECT c.id, c.count_date::text AS date, c.denominations, c.coins_minor AS "coinsMinor", c.counted_minor AS "countedMinor", c.book_minor AS "bookMinor",
            c.counted_minor - c.book_minor AS "differenceMinor", v.voucher_no AS "adjustmentNo", c.remarks
       FROM petty_cash_counts c LEFT JOIN vouchers v ON v.id = c.adjustment_voucher_id
      WHERE c.box_id = $1 AND c.count_date BETWEEN $2 AND $3 ORDER BY c.count_date DESC, c.created_at DESC`, [b.id, from, to]);
  return { box: { id: b.id, name: b.name, custodian: b.custodian, floatMinor: b.float_minor }, ...statement, byHead, counts };
}

/** For the bell: boxes that have fallen below a quarter of their float. */
export async function lowPettyCash(db: Db, companyId: string) {
  return (await listBoxes(db, companyId)).filter((b) => b.low);
}
