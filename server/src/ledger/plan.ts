import Decimal from 'decimal.js';
import { many, maybeOne } from '../db/client';
import { AppError } from '../lib/errors';
import { addDays } from '../lib/dates';
import { percentToPpm, toMinor } from '../lib/money';
import { computeGst } from '../tax/india-gst';
import type { ItemLine, VoucherInput } from './contracts';
import type { LedgerContext, LedgerInfo, Party } from './context';

export type AllocType = 'NEW_REF' | 'AGST_REF' | 'ADVANCE' | 'ON_ACCOUNT';

/** '$VNO' in a bill ref is replaced with the voucher number at posting time. */
export const VNO = '$VNO';

export interface PlanEntry {
  ledgerId: string;
  amountMinor: bigint;              // + debit, - credit
  bill?: { ref: string; type: AllocType; billDate: string; dueDate: string | null };
}

export interface PlanTaxLine {
  itemLineNo: number;
  hsnSac: string | null;
  component: string;
  ratePpm: number;
  taxableMinor: bigint;
  taxMinor: bigint;
  ledgerId: string;
  direction: 'INPUT' | 'OUTPUT';
  reverseCharge: boolean;
  itcEligible: boolean;
}

export interface PlanInventory {
  lineNo: number;
  itemId: string;
  godownId: string;
  qty: Decimal;                     // + inward, - outward
  unitCost: Decimal | null;
}

export interface Warning { code: string; message: string }

export interface Plan {
  baseType: VoucherInput['voucherType'];
  entries: PlanEntry[];
  taxLines: PlanTaxLine[];
  inventory: PlanInventory[];
  totalMinor: bigint;
  taxableMinor: bigint;
  taxMinor: bigint;
  roundOffMinor: bigint;
  counterpartyId: string | null;
  placeOfSupply: string | null;
  intraState: boolean | null;
  warnings: Warning[];
}

interface StockItemRow {
  id: string;
  name: string;
  sales_ledger_id: string | null;
  purchase_ledger_id: string | null;
  allow_negative: boolean;
}

const fail = (code: string, message: string) => new AppError(code, 422, message);

export async function buildPlan(ctx: LedgerContext, input: VoucherInput): Promise<Plan> {
  switch (input.voucherType) {
    case 'SALES': return tradingPlan(ctx, input, 'SALES_SIDE', 1n);
    case 'CREDIT_NOTE': return tradingPlan(ctx, input, 'SALES_SIDE', -1n);
    case 'PURCHASE': return tradingPlan(ctx, input, 'PURCHASE_SIDE', 1n);
    case 'DEBIT_NOTE': return tradingPlan(ctx, input, 'PURCHASE_SIDE', -1n);
    default: return accountingPlan(ctx, input);
  }
}

async function loadItems(ctx: LedgerContext, items: ItemLine[]) {
  const ids = [...new Set(items.map((i) => i.itemId).filter((x): x is string => Boolean(x)))];
  const rows = ids.length
    ? await many<StockItemRow>(ctx.db,
        `SELECT id, name, sales_ledger_id, purchase_ledger_id, allow_negative
           FROM stock_items WHERE company_id = $1 AND id = ANY($2::uuid[])`, [ctx.company.id, ids])
    : [];
  const map = new Map(rows.map((r) => [r.id, r]));
  for (const id of ids) if (!map.has(id)) throw fail('UNKNOWN_ITEM', `Stock item ${id} does not exist`);
  const godown = await maybeOne<{ id: string }>(ctx.db,
    `SELECT id FROM godowns WHERE company_id = $1 ORDER BY is_default DESC, name LIMIT 1`, [ctx.company.id]);
  return { map, defaultGodown: godown?.id ?? null };
}

/** The ledger that receives the money side: party (credit), cash, or bank. */
function settlementLedger(ctx: LedgerContext, input: VoucherInput, party: Party | null): LedgerInfo {
  if (input.paymentMode === 'CASH') return ctx.systemLedger('CASH');
  if (input.paymentMode === 'BANK') {
    if (!input.bankLedgerId) throw fail('BANK_REQUIRED', 'Choose the bank account');
    if (!ctx.isCashBank(input.bankLedgerId)) throw fail('NOT_A_BANK', 'The selected ledger is not a bank account');
    return ctx.ledger(input.bankLedgerId);
  }
  if (!party) throw fail('PARTY_REQUIRED', 'A credit voucher needs a party');
  return ctx.partyLedger(party.id);
}

async function tradingPlan(
  ctx: LedgerContext, input: VoucherInput, side: 'SALES_SIDE' | 'PURCHASE_SIDE', sign: 1n | -1n,
): Promise<Plan> {
  if (input.items.length === 0) throw fail('NO_ITEMS', 'Add at least one item or ledger line');
  const warnings: Warning[] = [];
  const party = input.counterpartyId ? await ctx.party(input.counterpartyId) : null;
  const companyState = ctx.company.state_code;
  const sales = side === 'SALES_SIDE';

  // Place of supply: sales -> customer's state; purchases -> our state, supplier's state decides intra/inter.
  const placeOfSupply = sales
    ? input.placeOfSupply ?? party?.state_code ?? companyState
    : input.placeOfSupply ?? companyState;
  const supplierState = sales ? companyState : party?.state_code ?? companyState;

  const { map: stock, defaultGodown } = await loadItems(ctx, input.items);
  const lines = input.items.map((it, idx) => {
    const amountMinor = toMinor(it.amount);
    if (amountMinor < 0n) throw fail('NEGATIVE_AMOUNT', `Line ${idx + 1}: amount cannot be negative`);
    const ratePpm = percentToPpm(it.gstRate);
    if (ratePpm % 2 !== 0) throw fail('BAD_RATE', `Line ${idx + 1}: GST rate ${it.gstRate}% cannot be split`);
    return { lineNo: idx + 1, amountMinor, ratePpm, cessPpm: percentToPpm(it.cessRate) };
  });

  const rcm = !sales && input.reverseCharge;
  const gst = computeGst(lines, {
    supplierState,
    placeOfSupply,
    pricesIncludeTax: input.pricesIncludeTax,
    roundToRupee: ctx.company.round_invoice && !rcm,
    // Supplies to or from an SEZ unit, and imports/exports (overseas party, or place of supply outside India), are IGST.
    forceInterState: party?.gst_reg_type === 'SEZ' || party?.gst_reg_type === 'OVERSEAS' || placeOfSupply === '96' || placeOfSupply === '97',
  });

  const entries: PlanEntry[] = [];
  const taxEntries: PlanEntry[] = [];
  const taxLines: PlanTaxLine[] = [];
  const inventory: PlanInventory[] = [];
  // Accounting sign for the goods/tax side: sales credits (-), purchases debit (+); notes flip.
  const goodsSign = (sales ? -1n : 1n) * sign;
  const ineligibleTaxByLine = new Map<number, bigint>();

  for (const t of gst.taxes) {
    const item = input.items[t.lineNo - 1];
    const eligible = sales || item.itcEligible;
    const direction = sales ? 'OUTPUT' : 'INPUT';
    if (!eligible) {
      ineligibleTaxByLine.set(t.lineNo, (ineligibleTaxByLine.get(t.lineNo) ?? 0n) + t.taxMinor);
    }
    const ledger = eligible ? await ctx.taxLedger(t.component, direction, t.ratePpm) : null;
    if (ledger) taxEntries.push({ ledgerId: ledger.id, amountMinor: goodsSign * t.taxMinor });
    if (rcm) {
      const payable = await ctx.taxLedger(t.component, 'RCM_PAYABLE', t.ratePpm);
      taxEntries.push({ ledgerId: payable.id, amountMinor: -goodsSign * t.taxMinor });
    }
    taxLines.push({
      itemLineNo: t.lineNo, hsnSac: item.hsnSac ?? null, component: t.component, ratePpm: t.ratePpm,
      taxableMinor: sign * t.taxableMinor, taxMinor: sign * t.taxMinor,
      ledgerId: ledger?.id ?? (await ctx.taxLedger(t.component, direction, t.ratePpm)).id,
      direction, reverseCharge: rcm, itcEligible: eligible,
    });
  }

  input.items.forEach((item, idx) => {
    const lineNo = idx + 1;
    const stockItem = item.itemId ? stock.get(item.itemId)! : null;
    const ledgerId = item.ledgerId
      ?? (sales ? stockItem?.sales_ledger_id : stockItem?.purchase_ledger_id)
      ?? ctx.systemLedger(sales ? 'SALES' : 'PURCHASE').id;
    const ledger = ctx.ledger(ledgerId);
    if (ledger.taxComponent) throw fail('BAD_ITEM_LEDGER', `Line ${lineNo}: ${ledger.name} is a tax ledger`);
    const cost = gst.taxableFor(lineNo) + (ineligibleTaxByLine.get(lineNo) ?? 0n);
    entries.push({ ledgerId, amountMinor: goodsSign * cost });

    if (stockItem) {
      if (!item.qty || new Decimal(item.qty).lte(0)) throw fail('QTY_REQUIRED', `Line ${lineNo}: quantity is required for ${stockItem.name}`);
      const qty = new Decimal(item.qty);
      const godownId = item.godownId ?? defaultGodown;
      if (!godownId) throw fail('NO_GODOWN', 'Create a godown first');
      const inward = (sales ? sign === -1n : sign === 1n);
      inventory.push({
        lineNo, itemId: stockItem.id, godownId,
        qty: inward ? qty : qty.neg(),
        // Purchases carry cost (taxable + non-creditable tax); returns are valued at running cost.
        unitCost: !sales && sign === 1n ? new Decimal(cost.toString()).div(100).div(qty) : null,
      });
    }
  });

  entries.push(...taxEntries);
  if (gst.roundOffMinor !== 0n) {
    entries.push({ ledgerId: ctx.systemLedger('ROUND_OFF').id, amountMinor: goodsSign * gst.roundOffMinor });
  }

  // Money side. Under RCM the supplier is owed only the taxable value; the tax goes to RCM payable.
  const settle = settlementLedger(ctx, input, party);
  const payable = rcm ? gst.taxableMinor : gst.grandTotalMinor;
  const settleEntry: PlanEntry = { ledgerId: settle.id, amountMinor: -goodsSign * payable };
  if (settle.billWise && settle.counterpartyId) {
    const billDate = (!sales && input.partyRefDate) || input.date;
    const due = input.dueDate ?? (party?.credit_days ? addDays(billDate, party.credit_days) : null);
    if (sign === 1n) {
      settleEntry.bill = { ref: (!sales && input.partyRefNo) || VNO, type: 'NEW_REF', billDate, dueDate: due };
    } else {
      settleEntry.bill = input.originalRef
        ? { ref: input.originalRef, type: 'AGST_REF', billDate: input.date, dueDate: null }
        : { ref: 'On Account', type: 'ON_ACCOUNT', billDate: input.date, dueDate: null };
    }
  }
  entries.unshift(settleEntry);   // party / cash / bank line first, Tally style

  if (input.paymentMode === 'CREDIT' && party) {
    const isDebtor = ctx.isDebtor(settle.id);
    const isCreditor = ctx.isCreditor(settle.id);
    if (sales && !isDebtor) {
      warnings.push({ code: 'PARTY_GROUP_MISMATCH', message: `${party.legal_name} is not under Sundry Debtors (it is under ${settle.groupName}).` });
    }
    if (!sales && !isCreditor) {
      warnings.push({ code: 'PARTY_GROUP_MISMATCH', message: `${party.legal_name} is not under Sundry Creditors (it is under ${settle.groupName}).` });
    }
  }
  if (input.voucherType === 'PURCHASE' && input.paymentMode === 'CREDIT' && !input.partyRefNo) {
    throw fail('SUPPLIER_INVOICE_REQUIRED', "Enter the supplier's invoice number");
  }
  if ((input.voucherType === 'CREDIT_NOTE' || input.voucherType === 'DEBIT_NOTE') && !input.originalRef) {
    warnings.push({ code: 'NO_ORIGINAL_INVOICE', message: 'GST requires a note to reference the original invoice.' });
  }

  const finalEntries = mergeSameLedger(entries);
  assertBalanced(finalEntries);
  return {
    baseType: input.voucherType,
    entries: finalEntries,
    taxLines,
    inventory,
    // The invoice value, not the debit sum (a round-off debit must not inflate it).
    totalMinor: payable,
    taxableMinor: gst.taxableMinor,
    taxMinor: gst.taxMinor,
    roundOffMinor: gst.roundOffMinor,
    counterpartyId: party?.id ?? null,
    placeOfSupply,
    intraState: gst.intraState,
    warnings,
  };
}

async function accountingPlan(ctx: LedgerContext, input: VoucherInput): Promise<Plan> {
  const t = input.voucherType;
  if (input.entries.length < 2) throw fail('TOO_FEW_LINES', 'A voucher needs at least two lines');
  const warnings: Warning[] = [];
  const entries: PlanEntry[] = [];

  for (const [idx, e] of input.entries.entries()) {
    const ledger = ctx.ledger(e.ledgerId);
    const amount = toMinor(e.amount);
    if (amount <= 0n) throw fail('BAD_AMOUNT', `Line ${idx + 1}: amount must be positive`);
    const signed = e.side === 'DR' ? amount : -amount;
    const entry: PlanEntry = { ledgerId: ledger.id, amountMinor: signed };
    if (ledger.billWise && ledger.counterpartyId) {
      entry.bill = await allocationFor(ctx, input, ledger, e.billRef ?? null, e.billType ?? null);
    }
    entries.push(entry);
  }

  const cashBankDr = input.entries.some((e) => e.side === 'DR' && ctx.isCashBank(e.ledgerId));
  const cashBankCr = input.entries.some((e) => e.side === 'CR' && ctx.isCashBank(e.ledgerId));
  if (t === 'PAYMENT' && !cashBankCr) throw fail('PAYMENT_NEEDS_CASH_BANK', 'A payment must be paid from a cash or bank ledger (credit side)');
  if (t === 'RECEIPT' && !cashBankDr) throw fail('RECEIPT_NEEDS_CASH_BANK', 'A receipt must go into a cash or bank ledger (debit side)');
  if (t === 'CONTRA' && !input.entries.every((e) => ctx.isCashBank(e.ledgerId))) {
    throw fail('CONTRA_ONLY_CASH_BANK', 'Contra entries can only use cash and bank ledgers');
  }
  if (t === 'JOURNAL' && !ctx.company.journal_allows_cash && input.entries.some((e) => ctx.isCashBank(e.ledgerId))) {
    throw fail('JOURNAL_NO_CASH_BANK', 'Use Payment, Receipt or Contra for cash and bank movements');
  }

  assertBalanced(entries);
  const partyEntry = input.entries.find((e) => ctx.ledger(e.ledgerId).counterpartyId);
  return {
    baseType: t,
    entries,
    taxLines: [],
    inventory: [],
    totalMinor: sumDebits(entries),
    taxableMinor: 0n,
    taxMinor: 0n,
    roundOffMinor: 0n,
    counterpartyId: input.counterpartyId ?? (partyEntry ? ctx.ledger(partyEntry.ledgerId).counterpartyId : null),
    placeOfSupply: null,
    intraState: null,
    warnings,
  };
}

async function allocationFor(
  ctx: LedgerContext, input: VoucherInput, ledger: LedgerInfo, billRef: string | null, billType: AllocType | null,
): Promise<NonNullable<PlanEntry['bill']>> {
  if (input.voucherType === 'OPENING') {
    return { ref: billRef ?? 'Opening', type: 'NEW_REF', billDate: input.date, dueDate: null };
  }
  if (!billRef) return { ref: 'On Account', type: 'ON_ACCOUNT', billDate: input.date, dueDate: null };
  const existing = await maybeOne<{ bill_date: string }>(ctx.db,
    `SELECT bill_date::text FROM bill_allocations
      WHERE company_id = $1 AND ledger_id = $2 AND bill_ref = $3 AND alloc_type = 'NEW_REF' LIMIT 1`,
    [ctx.company.id, ledger.id, billRef]);
  const type = billType ?? (existing ? 'AGST_REF' : 'NEW_REF');
  return { ref: billRef, type, billDate: existing?.bill_date ?? input.date, dueDate: null };
}

/** Lines on the same ledger without bill references are combined. */
export function mergeSameLedger(entries: PlanEntry[]): PlanEntry[] {
  const out: PlanEntry[] = [];
  const index = new Map<string, number>();
  for (const e of entries) {
    if (e.amountMinor === 0n) continue;
    if (e.bill) { out.push({ ...e }); continue; }
    const i = index.get(e.ledgerId);
    if (i === undefined) {
      index.set(e.ledgerId, out.length);
      out.push({ ...e });
    } else {
      out[i] = { ...out[i], amountMinor: out[i].amountMinor + e.amountMinor };
    }
  }
  return out.filter((e) => e.amountMinor !== 0n);
}

export function assertBalanced(entries: PlanEntry[]) {
  const sum = entries.reduce((s, e) => s + e.amountMinor, 0n);
  if (sum !== 0n) throw new AppError('UNBALANCED', 422, `Debits and credits differ by ${sum} paise`);
  if (entries.length < 2) throw new AppError('UNBALANCED', 422, 'A voucher needs at least two non-zero lines');
}

const sumDebits = (entries: PlanEntry[]) => entries.reduce((s, e) => (e.amountMinor > 0n ? s + e.amountMinor : s), 0n);
