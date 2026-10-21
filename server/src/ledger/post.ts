import crypto from 'node:crypto';
import Decimal from 'decimal.js';
import { many, maybeOne, one, type Db, type Database } from '../db/client';
import { AppError, invalid, notFound } from '../lib/errors';
import { fiscalYear, todayIST } from '../lib/dates';
import { qtyOnHand } from '../inventory/stock';
import { VoucherInput, type VoucherInputRaw, type BaseType } from './contracts';
import { LedgerContext } from './context';
import { buildPlan, VNO, type AllocType, type Plan, type PlanEntry, type PlanInventory, type PlanTaxLine } from './plan';

export type Source = 'MANUAL' | 'OCR' | 'VOICE' | 'IMPORT' | 'API' | 'SYSTEM';

export interface PostOptions {
  source: Source;
  idempotencyKey: string;
  userId: string;
  draftId?: string | null;
  /** Alter checks stock once, after both the reversal and the corrected voucher are in. */
  skipStockCheck?: boolean;
}

export interface PostedVoucher {
  id: string;
  voucherNo: string;
  voucherType: BaseType;
  date: string;
  totalMinor: bigint;
  alreadyPosted: boolean;
}

export function parseInput(raw: unknown): VoucherInput {
  const r = VoucherInput.safeParse(raw);
  if (!r.success) {
    throw invalid('Voucher is not valid', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  return r.data;
}

/** Validate + compute without writing anything (tax ledgers created on the fly are rolled back). */
export async function previewVoucher(db: Database, companyId: string, raw: VoucherInputRaw | unknown) {
  const input = parseInput(raw);
  let result: Awaited<ReturnType<typeof describePlan>> | null = null;
  const ROLLBACK = new Error('preview-rollback');
  try {
    await db.transaction(async (tx) => {
      const ctx = await LedgerContext.load(tx, companyId);
      const plan = await buildPlan(ctx, input);
      result = describePlan(ctx, plan);
      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
  return result!;
}

export function describePlan(ctx: LedgerContext, plan: Plan) {
  return {
    totalMinor: plan.totalMinor,
    taxableMinor: plan.taxableMinor,
    taxMinor: plan.taxMinor,
    roundOffMinor: plan.roundOffMinor,
    placeOfSupply: plan.placeOfSupply,
    intraState: plan.intraState,
    warnings: plan.warnings,
    entries: plan.entries.map((e) => ({
      ledgerId: e.ledgerId, ledgerName: ctx.ledger(e.ledgerId).name, amountMinor: e.amountMinor, bill: e.bill ?? null,
    })),
    taxes: plan.taxLines.map((t) => ({
      component: t.component, ratePpm: t.ratePpm, taxableMinor: t.taxableMinor, taxMinor: t.taxMinor,
      ledgerName: ctx.ledger(t.ledgerId).name, itemLineNo: t.itemLineNo,
    })),
  };
}

export async function postVoucher(db: Database, companyId: string, raw: unknown, opts: PostOptions): Promise<PostedVoucher> {
  const input = parseInput(raw);
  return db.transaction((tx) => postInTx(tx, companyId, input, opts));
}

/** Posts inside a caller's transaction (used by Alter = reverse + re-post atomically). */
export async function postInTx(tx: Db, companyId: string, input: VoucherInput, opts: PostOptions): Promise<PostedVoucher> {
  {
    const existing = await maybeOne<{ id: string; voucher_no: string; voucher_date: string; total_minor: bigint }>(tx,
      `SELECT id, voucher_no, voucher_date::text, total_minor FROM vouchers WHERE company_id = $1 AND idempotency_key = $2`,
      [companyId, opts.idempotencyKey]);
    if (existing) {
      return { id: existing.id, voucherNo: existing.voucher_no, voucherType: input.voucherType, date: existing.voucher_date, totalMinor: existing.total_minor, alreadyPosted: true };
    }

    const ctx = await LedgerContext.load(tx, companyId);
    const plan = await buildPlan(ctx, input);
    if (plan.warnings.length && !input.confirmWarnings) {
      throw new AppError('CONFIRM_WARNINGS', 409, plan.warnings.map((w) => w.message).join(' '), { warnings: plan.warnings });
    }

    if (input.voucherType !== 'OPENING') {
      if (input.date < ctx.company.books_from) throw new AppError('BEFORE_BOOKS', 422, `Books begin on ${ctx.company.books_from}`);
      if (ctx.company.lock_date && input.date <= ctx.company.lock_date) {
        throw new AppError('PERIOD_LOCKED', 422, `Books are locked up to ${ctx.company.lock_date}`);
      }
    }
    const fy = fiscalYear(input.date, ctx.company.fy_start_month);
    if (input.voucherType === 'PURCHASE' && input.partyRefNo && plan.counterpartyId) {
      await assertNotDuplicateBill(tx, companyId, plan.counterpartyId, fy, input.partyRefNo);
    }
    await assertStockAvailable(tx, companyId, input.date, plan.inventory);

    const type = await voucherType(tx, companyId, input.voucherType);
    const voucherNo = await nextNumber(tx, type.id, fy, { prefix: type.prefix, base: input.voucherType, date: input.date, company: ctx.company });
    const v = await insertPosted(tx, {
      companyId,
      voucherTypeId: type.id,
      fiscalYear: fy,
      voucherNo,
      date: input.date,
      counterpartyId: plan.counterpartyId,
      partyRefNo: input.partyRefNo ?? null,
      partyRefDate: input.partyRefDate ?? null,
      originalRef: input.originalRef ?? null,
      placeOfSupply: plan.placeOfSupply,
      reverseCharge: input.reverseCharge,
      paymentMode: ['SALES', 'PURCHASE', 'CREDIT_NOTE', 'DEBIT_NOTE'].includes(input.voucherType) ? input.paymentMode : null,
      narration: input.narration ?? null,
      totalMinor: plan.totalMinor,
      source: opts.source,
      draftId: opts.draftId ?? null,
      input: { ...input, confirmWarnings: false },
      idempotencyKey: opts.idempotencyKey,
      reversesVoucherId: null,
      userId: opts.userId,
      entries: plan.entries,
      taxLines: plan.taxLines,
      inventory: plan.inventory,
    });
    if (!opts.skipStockCheck) {
      await assertStockNeverNegative(tx, companyId, plan.inventory.filter((m) => m.qty.lt(0)).map((m) => m.itemId), input.date);
    }
    if (opts.draftId) {
      await tx.query(`UPDATE voucher_drafts SET status = 'POSTED', posted_voucher_id = $2, updated_at = now() WHERE id = $1`, [opts.draftId, v.id]);
    }
    await audit(tx, companyId, opts.userId, opts.source, 'POST', 'voucher', v.id, null, { voucherNo, type: input.voucherType, total: plan.totalMinor.toString() });
    return { id: v.id, voucherNo, voucherType: input.voucherType, date: input.date, totalMinor: plan.totalMinor, alreadyPosted: false };
  }
}

async function assertNotDuplicateBill(tx: Db, companyId: string, counterpartyId: string, fy: number, ref: string) {
  const dup = await maybeOne<{ id: string; voucher_no: string }>(tx,
    `SELECT v.id, v.voucher_no FROM vouchers v JOIN voucher_types t ON t.id = v.voucher_type_id
      WHERE v.company_id = $1 AND v.counterparty_id = $2 AND v.fiscal_year = $3
        AND lower(v.party_ref_no) = lower($4) AND t.base_type = 'PURCHASE'
        AND v.reverses_voucher_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM vouchers r WHERE r.reverses_voucher_id = v.id)`,
    [companyId, counterpartyId, fy, ref]);
  if (dup) {
    throw new AppError('DUPLICATE_BILL', 409, `Supplier invoice ${ref} is already booked as Purchase ${dup.voucher_no}`, { voucherId: dup.id });
  }
}

async function assertStockAvailable(tx: Db, companyId: string, date: string, inventory: PlanInventory[]) {
  const outward = new Map<string, Decimal>();
  for (const m of inventory) if (m.qty.lt(0)) outward.set(m.itemId, (outward.get(m.itemId) ?? new Decimal(0)).plus(m.qty.neg()));
  for (const [itemId, qty] of outward) {
    const item = await one<{ name: string; allow_negative: boolean }>(tx, `SELECT name, allow_negative FROM stock_items WHERE id = $1`, [itemId]);
    if (item.allow_negative) continue;
    const onHand = await qtyOnHand(tx, companyId, itemId, date);
    if (onHand.lt(qty)) {
      throw new AppError('NEGATIVE_STOCK', 422, `Only ${onHand.toString()} of ${item.name} in stock on ${date}; this voucher needs ${qty.toString()}`);
    }
  }
}

/**
 * Stock of each item must not fall below zero on any day from `from` onwards. Checking only the voucher's own
 * date misses a backdated sale, or a reversed purchase, whose goods later vouchers have already sold.
 */
async function assertStockNeverNegative(tx: Db, companyId: string, itemIds: string[], from: string) {
  for (const itemId of new Set(itemIds)) {
    const item = await one<{ name: string; allow_negative: boolean }>(tx, `SELECT name, allow_negative FROM stock_items WHERE id = $1`, [itemId]);
    if (item.allow_negative) continue;
    const low = await maybeOne<{ d: string; bal: string }>(tx,
      `WITH daily AS (
         SELECT voucher_date, SUM(qty) AS q FROM inventory_entries WHERE company_id = $1 AND item_id = $2 GROUP BY voucher_date
       ), running AS (
         SELECT voucher_date, SUM(q) OVER (ORDER BY voucher_date) AS bal FROM daily
       )
       SELECT voucher_date::text AS d, bal::text AS bal FROM running WHERE voucher_date >= $3 ORDER BY bal, voucher_date LIMIT 1`,
      [companyId, itemId, from]);
    if (low && new Decimal(low.bal).lt(0)) {
      throw new AppError('NEGATIVE_STOCK', 422,
        `Not enough ${item.name}: with this change, stock would fall to ${low.bal} on ${low.d}, because later vouchers already use it.`);
    }
  }
}

async function voucherType(tx: Db, companyId: string, base: BaseType) {
  const t = await maybeOne<{ id: string; prefix: string }>(tx,
    `SELECT id, prefix FROM voucher_types WHERE company_id = $1 AND base_type = $2 ORDER BY is_default DESC LIMIT 1`, [companyId, base]);
  if (!t) throw new AppError('NO_VOUCHER_TYPE', 500, `No voucher type for ${base}`);
  return t;
}

const TRADING = new Set<BaseType>(['SALES', 'PURCHASE', 'CREDIT_NOTE', 'DEBIT_NOTE']);
/** The document that undoes each trading voucher once its period is closed. */
const NOTE_FOR: Record<string, BaseType> = { SALES: 'CREDIT_NOTE', PURCHASE: 'DEBIT_NOTE', CREDIT_NOTE: 'SALES', DEBIT_NOTE: 'PURCHASE' };

/**
 * A ready-to-post draft that undoes a sale or purchase from a closed period: a credit note against a sale, a debit
 * note against a purchase (and a fresh invoice to undo a note), dated today, with the original's party and lines.
 * It is only a draft: the voucher screen shows it for checking before anything is posted.
 */
export async function correctionNote(db: Db, companyId: string, voucherId: string) {
  const v = await maybeOne<{ voucher_no: string; voucher_date: string; base_type: BaseType; party_ref_no: string | null; input: VoucherInputRaw | null }>(db,
    `SELECT v.voucher_no, v.voucher_date::text, t.base_type, v.party_ref_no, v.input
       FROM vouchers v JOIN voucher_types t ON t.id = v.voucher_type_id WHERE v.id = $1 AND v.company_id = $2`, [voucherId, companyId]);
  if (!v) throw notFound('Voucher');
  if (!TRADING.has(v.base_type) || !v.input) throw new AppError('NO_NOTE', 422, 'Only sales, purchases and notes are corrected with a note');
  const type = NOTE_FOR[v.base_type];
  const i = v.input;
  // A purchase's debit note quotes the supplier's invoice number; a sale's credit note quotes our invoice.
  const originalRef = v.base_type === 'PURCHASE' ? (v.party_ref_no ?? v.voucher_no) : v.base_type === 'SALES' ? v.voucher_no : null;
  return {
    voucherType: type, date: todayIST(), counterpartyId: i.counterpartyId ?? null, paymentMode: i.paymentMode, bankLedgerId: i.bankLedgerId ?? null,
    placeOfSupply: i.placeOfSupply ?? null, pricesIncludeTax: i.pricesIncludeTax, reverseCharge: type === 'PURCHASE' || type === 'DEBIT_NOTE' ? i.reverseCharge : false,
    originalRef: originalRef?.slice(0, 16) ?? null, partyRefNo: null, partyRefDate: null,
    items: i.items ?? [],
    narration: `Against ${v.base_type.replace('_', ' ').toLowerCase()} ${v.voucher_no} of ${v.voucher_date} (period closed)`,
  } satisfies VoucherInputRaw;
}

/** Short code per voucher type in financial-year numbers (SI/27-28/0001). */
export const TYPE_CODE: Record<BaseType, string> = {
  SALES: 'SI', PURCHASE: 'PI', CREDIT_NOTE: 'CN', DEBIT_NOTE: 'DN', PAYMENT: 'PY', RECEIPT: 'RC', CONTRA: 'CT', JOURNAL: 'JV', OPENING: 'OB',
};

/**
 * The number a voucher is shown and printed with. From the company's fy_numbering_from date it carries the type and
 * financial year (SI/27-28/0001, at most 16 characters as GST rule 46 allows), so invoices of different years never
 * share a number; before that date, the plain running number used until then.
 */
export function formatVoucherNo(no: bigint, o: { prefix: string; base: BaseType; date: string; fyNumberingFrom: string | null; fyStartMonth: number }): string {
  if (!o.fyNumberingFrom || o.date < o.fyNumberingFrom) return `${o.prefix}${no}`;
  const y = Number(o.date.slice(0, 4));
  const start = Number(o.date.slice(5, 7)) >= o.fyStartMonth ? y : y - 1;
  const label = o.fyStartMonth === 1 ? String(start) : `${String(start % 100).padStart(2, '0')}-${String((start + 1) % 100).padStart(2, '0')}`;
  return `${TYPE_CODE[o.base]}/${label}/${String(no).padStart(4, '0')}`;
}

async function nextNumber(tx: Db, voucherTypeId: string, fy: number,
  o: { prefix: string; base: BaseType; date: string; company: { fy_numbering_from: string | null; fy_start_month: number } }): Promise<string> {
  const r = await one<{ no: bigint }>(tx,
    `INSERT INTO voucher_series (voucher_type_id, fiscal_year, next_no) VALUES ($1, $2, 2)
     ON CONFLICT (voucher_type_id, fiscal_year) DO UPDATE SET next_no = voucher_series.next_no + 1
     RETURNING next_no - 1 AS no`, [voucherTypeId, fy]);
  return formatVoucherNo(r.no, { prefix: o.prefix, base: o.base, date: o.date, fyNumberingFrom: o.company.fy_numbering_from, fyStartMonth: o.company.fy_start_month });
}

interface PostedRecord {
  companyId: string;
  voucherTypeId: string;
  fiscalYear: number;
  voucherNo: string;
  date: string;
  counterpartyId: string | null;
  partyRefNo: string | null;
  partyRefDate: string | null;
  originalRef: string | null;
  placeOfSupply: string | null;
  reverseCharge: boolean;
  paymentMode: string | null;
  narration: string | null;
  totalMinor: bigint;
  source: Source;
  draftId: string | null;
  input: unknown;
  idempotencyKey: string;
  reversesVoucherId: string | null;
  userId: string;
  entries: PlanEntry[];
  taxLines: PlanTaxLine[];
  inventory: PlanInventory[];
}

/** Canonical bytes that the hash chain covers. Must be reproducible from stored rows (see verifyChain). */
export function canonicalVoucher(v: {
  id: string; companyId: string; voucherTypeId: string; voucherNo: string; date: string; totalMinor: bigint;
  chainSeq: bigint; entries: { lineNo: number; ledgerId: string; amountMinor: bigint }[];
}): string {
  return JSON.stringify({
    id: v.id, company: v.companyId, type: v.voucherTypeId, no: v.voucherNo, date: v.date,
    total: v.totalMinor.toString(), seq: v.chainSeq.toString(),
    entries: v.entries.map((e) => [e.lineNo, e.ledgerId, e.amountMinor.toString()]),
  });
}

export function chainHash(prev: Uint8Array | null, canonical: string): Buffer {
  const h = crypto.createHash('sha256');
  if (prev) h.update(prev);
  h.update(canonical);
  return h.digest();
}

async function insertPosted(tx: Db, r: PostedRecord): Promise<{ id: string; chainSeq: bigint }> {
  // Serialises posting per company (PGlite runs one transaction at a time; on server Postgres this takes the lock).
  await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [r.companyId]);
  const prev = await maybeOne<{ chain_seq: bigint; row_hash: Uint8Array }>(tx,
    `SELECT chain_seq, row_hash FROM vouchers WHERE company_id = $1 ORDER BY chain_seq DESC LIMIT 1`, [r.companyId]);
  const chainSeq = (prev?.chain_seq ?? 0n) + 1n;
  const id = crypto.randomUUID();
  const lines = r.entries.map((e, i) => ({ lineNo: i + 1, ledgerId: e.ledgerId, amountMinor: e.amountMinor }));
  const rowHash = chainHash(prev?.row_hash ?? null, canonicalVoucher({
    id, companyId: r.companyId, voucherTypeId: r.voucherTypeId, voucherNo: r.voucherNo, date: r.date,
    totalMinor: r.totalMinor, chainSeq, entries: lines,
  }));

  await tx.query(
    `INSERT INTO vouchers (id, company_id, voucher_type_id, fiscal_year, voucher_no, voucher_date, counterparty_id,
       party_ref_no, party_ref_date, original_ref, place_of_supply, reverse_charge, payment_mode, narration,
       total_minor, source, draft_id, input, idempotency_key, reverses_voucher_id, chain_seq, prev_hash, row_hash, posted_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
    [id, r.companyId, r.voucherTypeId, r.fiscalYear, r.voucherNo, r.date, r.counterpartyId, r.partyRefNo,
      r.partyRefDate, r.originalRef, r.placeOfSupply, r.reverseCharge, r.paymentMode, r.narration, r.totalMinor,
      r.source, r.draftId, JSON.stringify(r.input, bigintJson), r.idempotencyKey, r.reversesVoucherId, chainSeq,
      prev?.row_hash ?? null, rowHash, r.userId]);

  for (const [i, e] of r.entries.entries()) {
    const le = await one<{ id: bigint }>(tx,
      `INSERT INTO ledger_entries (company_id, voucher_id, line_no, ledger_id, amount_minor, voucher_date)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [r.companyId, id, i + 1, e.ledgerId, e.amountMinor, r.date]);
    if (e.bill) {
      await tx.query(
        `INSERT INTO bill_allocations (company_id, ledger_entry_id, ledger_id, bill_ref, alloc_type, amount_minor, bill_date, due_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [r.companyId, le.id, e.ledgerId, e.bill.ref === VNO ? r.voucherNo : e.bill.ref, e.bill.type, e.amountMinor,
          e.bill.billDate, e.bill.dueDate]);
    }
  }
  for (const t of r.taxLines) {
    await tx.query(
      `INSERT INTO voucher_tax_lines (company_id, voucher_id, item_line_no, hsn_sac, component, rate_ppm, taxable_minor,
         tax_minor, ledger_id, direction, reverse_charge, itc_eligible, voucher_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [r.companyId, id, t.itemLineNo, t.hsnSac, t.component, t.ratePpm, t.taxableMinor, t.taxMinor, t.ledgerId,
        t.direction, t.reverseCharge, t.itcEligible, r.date]);
  }
  for (const m of r.inventory) {
    await tx.query(
      `INSERT INTO inventory_entries (company_id, voucher_id, line_no, item_id, godown_id, qty, unit_cost, voucher_date, chain_seq)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [r.companyId, id, m.lineNo, m.itemId, m.godownId, m.qty.toString(), m.unitCost?.toFixed(6) ?? null, r.date, chainSeq]);
  }
  return { id, chainSeq };
}

export const bigintJson = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);

/** Posts the mirror image of a voucher. The original stays; reports net the two to zero. */
type ReverseOptions = { userId: string; source: Source; date?: string; idempotencyKey?: string; skipStockCheck?: boolean };

export async function reverseVoucher(db: Database, companyId: string, voucherId: string, opts: ReverseOptions): Promise<PostedVoucher> {
  return db.transaction((tx) => reverseInTx(tx, companyId, voucherId, opts));
}

export async function reverseInTx(tx: Db, companyId: string, voucherId: string, opts: ReverseOptions): Promise<PostedVoucher> {
  {
    const v = await maybeOne<{
      id: string; voucher_type_id: string; voucher_no: string; voucher_date: string; counterparty_id: string | null;
      reverses_voucher_id: string | null; total_minor: bigint; base_type: BaseType; prefix: string; place_of_supply: string | null;
      party_ref_no: string | null; party_ref_date: string | null; original_ref: string | null; reverse_charge: boolean; payment_mode: string | null;
    }>(tx,
      `SELECT v.id, v.voucher_type_id, v.voucher_no, v.voucher_date::text, v.counterparty_id, v.reverses_voucher_id,
              v.total_minor, t.base_type, t.prefix, v.place_of_supply, v.party_ref_no, v.party_ref_date::text,
              v.original_ref, v.reverse_charge, v.payment_mode
         FROM vouchers v JOIN voucher_types t ON t.id = v.voucher_type_id
        WHERE v.id = $1 AND v.company_id = $2`, [voucherId, companyId]);
    if (!v) throw notFound('Voucher');
    if (v.reverses_voucher_id) throw new AppError('IS_REVERSAL', 422, 'A reversal cannot itself be reversed; post a new voucher instead');
    const already = await maybeOne<{ voucher_no: string }>(tx, `SELECT voucher_no FROM vouchers WHERE reverses_voucher_id = $1`, [voucherId]);
    if (already) throw new AppError('ALREADY_REVERSED', 409, `Already reversed by ${already.voucher_no}`);

    const ctx = await LedgerContext.load(tx, companyId);
    const locked = Boolean(ctx.company.lock_date && v.voucher_date <= ctx.company.lock_date);
    // An invoice in a closed (locked, possibly already filed) period is not reversed: GST corrects it with a credit
    // or debit note dated today against the original. correctionNote() prepares that note.
    if (locked && TRADING.has(v.base_type)) {
      const note = NOTE_FOR[v.base_type];
      throw new AppError('USE_NOTE', 409,
        `${v.base_type.replace('_', ' ').toLowerCase()} ${v.voucher_no} is in a closed period (books locked up to ${ctx.company.lock_date}). Issue a ${note.replace('_', ' ').toLowerCase()} dated today instead.`,
        { voucherId: v.id, voucherNo: v.voucher_no, noteType: note });
    }
    let date = opts.date ?? v.voucher_date;
    // Payments, receipts, journals and contras in a closed period are reversed with today's date.
    if (ctx.company.lock_date && date <= ctx.company.lock_date) date = todayIST();

    const entries = await many<{ ledger_id: string; amount_minor: bigint; bill_ref: string | null; alloc_type: string | null; bill_date: string | null; due_date: string | null }>(tx,
      `SELECT e.ledger_id, e.amount_minor, b.bill_ref, b.alloc_type, b.bill_date::text, b.due_date::text
         FROM ledger_entries e LEFT JOIN bill_allocations b ON b.ledger_entry_id = e.id
        WHERE e.voucher_id = $1 ORDER BY e.line_no`, [voucherId]);
    const taxLines = await many<{ item_line_no: number; hsn_sac: string | null; component: string; rate_ppm: number; taxable_minor: bigint; tax_minor: bigint; ledger_id: string; direction: 'INPUT' | 'OUTPUT'; reverse_charge: boolean; itc_eligible: boolean }>(tx,
      `SELECT item_line_no, hsn_sac, component, rate_ppm, taxable_minor, tax_minor, ledger_id, direction, reverse_charge, itc_eligible
         FROM voucher_tax_lines WHERE voucher_id = $1`, [voucherId]);
    const inv = await many<{ line_no: number; item_id: string; godown_id: string; qty: string; unit_cost: string | null }>(tx,
      `SELECT line_no, item_id, godown_id, qty::text, unit_cost::text FROM inventory_entries WHERE voucher_id = $1 ORDER BY line_no`, [voucherId]);

    const fy = fiscalYear(date, ctx.company.fy_start_month);
    const voucherNo = await nextNumber(tx, v.voucher_type_id, fy, { prefix: v.prefix, base: v.base_type, date, company: ctx.company });
    const posted = await insertPosted(tx, {
      companyId, voucherTypeId: v.voucher_type_id, fiscalYear: fy, voucherNo, date,
      counterpartyId: v.counterparty_id, partyRefNo: null, partyRefDate: null, originalRef: v.voucher_no,
      placeOfSupply: v.place_of_supply, reverseCharge: v.reverse_charge, paymentMode: v.payment_mode,
      narration: `Reversal of ${v.base_type.replace('_', ' ').toLowerCase()} ${v.voucher_no}`,
      totalMinor: v.total_minor, source: opts.source, draftId: null, input: null,
      idempotencyKey: opts.idempotencyKey ?? `reverse:${voucherId}`, reversesVoucherId: voucherId, userId: opts.userId,
      entries: entries.map((e) => ({
        ledgerId: e.ledger_id, amountMinor: -e.amount_minor,
        bill: e.bill_ref ? { ref: e.bill_ref, type: e.alloc_type as AllocType, billDate: e.bill_date!, dueDate: e.due_date } : undefined,
      })),
      taxLines: taxLines.map((t) => ({
        itemLineNo: t.item_line_no, hsnSac: t.hsn_sac, component: t.component, ratePpm: t.rate_ppm,
        taxableMinor: -t.taxable_minor, taxMinor: -t.tax_minor, ledgerId: t.ledger_id, direction: t.direction,
        reverseCharge: t.reverse_charge, itcEligible: t.itc_eligible,
      })),
      inventory: inv.map((m) => ({
        lineNo: m.line_no, itemId: m.item_id, godownId: m.godown_id, qty: new Decimal(m.qty).neg(),
        unitCost: m.unit_cost === null ? null : new Decimal(m.unit_cost),
      })),
    });
    if (!opts.skipStockCheck) {
      // Reversing a purchase takes its goods back out; they may already have been sold.
      await assertStockNeverNegative(tx, companyId, inv.filter((m) => new Decimal(m.qty).gt(0)).map((m) => m.item_id), date);
    }
    await audit(tx, companyId, opts.userId, opts.source, 'REVERSE', 'voucher', voucherId, null, { reversal: posted.id, voucherNo });
    return { id: posted.id, voucherNo, voucherType: v.base_type, date, totalMinor: v.total_minor, alreadyPosted: false };
  }
}

/** Re-walks the hash chain; returns the first broken link if any. */
export async function verifyChain(db: Db, companyId: string) {
  const vs = await many<{ id: string; voucher_type_id: string; voucher_no: string; voucher_date: string; total_minor: bigint; chain_seq: bigint; prev_hash: Uint8Array | null; row_hash: Uint8Array }>(db,
    `SELECT id, voucher_type_id, voucher_no, voucher_date::text, total_minor, chain_seq, prev_hash, row_hash
       FROM vouchers WHERE company_id = $1 ORDER BY chain_seq`, [companyId]);
  let prev: Uint8Array | null = null;
  for (const v of vs) {
    const entries = await many<{ line_no: number; ledger_id: string; amount_minor: bigint }>(db,
      `SELECT line_no, ledger_id, amount_minor FROM ledger_entries WHERE voucher_id = $1 ORDER BY line_no`, [v.id]);
    const expected = chainHash(prev, canonicalVoucher({
      id: v.id, companyId, voucherTypeId: v.voucher_type_id, voucherNo: v.voucher_no, date: v.voucher_date,
      totalMinor: v.total_minor, chainSeq: v.chain_seq,
      entries: entries.map((e) => ({ lineNo: e.line_no, ledgerId: e.ledger_id, amountMinor: e.amount_minor })),
    }));
    if (!Buffer.from(v.row_hash).equals(expected)) {
      return { ok: false as const, checked: Number(v.chain_seq) - 1, brokenAt: { voucherId: v.id, voucherNo: v.voucher_no, chainSeq: v.chain_seq } };
    }
    prev = v.row_hash;
  }
  return { ok: true as const, checked: vs.length, head: prev ? Buffer.from(prev).toString('hex') : null };
}

export async function audit(db: Db, companyId: string, actor: string, channel: string, action: string, entity: string, entityId: string | null, before: unknown, after: unknown) {
  await db.query(
    `INSERT INTO audit_log (company_id, actor, channel, action, entity, entity_id, before, after) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [companyId, actor, channel, action, entity, entityId, before === null ? null : JSON.stringify(before, bigintJson), after === null ? null : JSON.stringify(after, bigintJson)]);
}

/** Alter = reverse the original and post the corrected voucher, atomically. */
export async function alterVoucher(db: Database, companyId: string, voucherId: string, raw: unknown, opts: PostOptions) {
  const input = parseInput(raw);
  return db.transaction(async (tx) => {
    const reversal = await reverseInTx(tx, companyId, voucherId, { userId: opts.userId, source: opts.source, idempotencyKey: `alter-reverse:${opts.idempotencyKey}`, skipStockCheck: true });
    const posted = await postInTx(tx, companyId, input, { ...opts, skipStockCheck: true });
    // Stock is checked on the net result: correcting a purchase whose goods were sold is fine if the corrected one still covers them.
    const items = await many<{ item_id: string }>(tx, `SELECT DISTINCT item_id FROM inventory_entries WHERE voucher_id = ANY($1::uuid[])`, [[reversal.id, posted.id]]);
    const from = reversal.date < posted.date ? reversal.date : posted.date;
    await assertStockNeverNegative(tx, companyId, items.map((r) => r.item_id), from);
    return { reversal, posted };
  });
}
