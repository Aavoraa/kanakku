import { AppError, invalid } from '../lib/errors';
import { DEC_RE } from '../lib/money';
import { LedgerContext } from './context';
import type { VoucherInputRaw } from './contracts';
import { postVoucher, previewVoucher, type PostedVoucher, type Source } from './post';
import type { Warning } from './plan';
import type { Database } from '../db/client';

/** One expense paid from cash, bank or petty cash: a petty voucher, a repair bill, a small purchase. */
export interface ExpenseInput {
  date: string;
  /** Expense (or fixed-asset) ledger the cost goes to. */
  expenseLedgerId: string;
  /** What was paid: the bill total, GST included. */
  amount: string;
  /** GST % on the bill; 0 or empty when the bill has no GST (unregistered vendor, exempt). */
  gstRate?: string | null;
  /** Cash, bank or petty cash ledger the money left from. */
  paidFromLedgerId: string;
  paidTo?: string | null;
  billNo?: string | null;
  narration?: string | null;
}

/**
 * Builds the voucher: a Payment (Dr expense, Cr cash/bank) for a bill without GST, or a Purchase paid from
 * that cash/bank ledger with GST included in the amount, so the input tax lands in the GST ledgers and returns.
 */
export function expenseVoucher(ctx: LedgerContext, e: ExpenseInput): VoucherInputRaw {
  if (!e.date || !/^\d{4}-\d{2}-\d{2}$/.test(e.date)) throw invalid('Enter the date');
  const amount = String(e.amount ?? '').replace(/,/g, '').trim();
  if (!DEC_RE.test(amount) || Number(amount) <= 0) throw invalid('Enter the amount paid, like 450 or 1180.50');
  const exp = ctx.ledger(e.expenseLedgerId);
  if (exp.taxComponent || ctx.isCashBank(exp.id) || exp.counterpartyId || !(exp.nature === 'EXPENSE' || exp.path.includes('fixed_assets'))) {
    throw invalid(`${exp.name} is not an expense ledger. Choose an expense head such as Office Expenses or Repairs.`);
  }
  if (!ctx.isCashBank(e.paidFromLedgerId)) throw invalid('Choose the cash, bank or petty cash ledger it was paid from');
  const rate = String(e.gstRate ?? '').trim() || '0';
  if (!/^\d+(\.\d+)?$/.test(rate)) throw invalid('GST rate is not a number');
  const who = e.paidTo?.trim() ? `Paid to ${e.paidTo.trim()}` : '';
  const narration = [who, e.narration?.trim(), e.billNo?.trim() ? `bill ${e.billNo.trim()}` : ''].filter(Boolean).join(' · ') || null;
  if (Number(rate) > 0) {
    return {
      voucherType: 'PURCHASE', date: e.date, paymentMode: 'BANK', bankLedgerId: e.paidFromLedgerId, pricesIncludeTax: true,
      partyRefNo: e.billNo?.trim().slice(0, 16) || null, partyRefDate: e.billNo?.trim() ? e.date : null,
      items: [{ ledgerId: exp.id, amount, gstRate: rate, description: e.paidTo?.trim() || null }], narration,
    };
  }
  return {
    voucherType: 'PAYMENT', date: e.date, narration,
    entries: [{ ledgerId: exp.id, side: 'DR', amount }, { ledgerId: e.paidFromLedgerId, side: 'CR', amount }],
  };
}

/**
 * Posts an expense. Warnings from the posting engine and the caller's own (limits, s.40A(3)) are shown together
 * and must be confirmed together; nothing is posted until they are.
 */
export async function postExpense(
  db: Database, companyId: string, e: ExpenseInput,
  opts: { idempotencyKey: string; userId: string; source?: Source; confirmWarnings?: boolean; extraWarnings?: Warning[] },
): Promise<PostedVoucher> {
  const ctx = await LedgerContext.load(db, companyId);
  const input = expenseVoucher(ctx, e);
  const preview = await previewVoucher(db, companyId, input);
  const warnings = [...(opts.extraWarnings ?? []), ...preview.warnings];
  // Income-tax s.40A(3): a cash payment over Rs 10,000 to one person in a day is not allowed as a deduction.
  const fromCash = ctx.ledger(e.paidFromLedgerId).path.includes('cash_in_hand');
  if (fromCash && preview.totalMinor > 1_000_000n) {
    warnings.push({ code: 'CASH_40A3', message: 'Cash payments above ₹10,000 to one person in a day are not allowed as an income-tax deduction (s.40A(3)). Pay by bank if you can.' });
  }
  if (warnings.length && !opts.confirmWarnings) {
    throw new AppError('CONFIRM_WARNINGS', 409, warnings.map((w) => w.message).join(' '), { warnings });
  }
  return postVoucher(db, companyId, { ...input, confirmWarnings: true }, { source: opts.source ?? 'MANUAL', idempotencyKey: opts.idempotencyKey, userId: opts.userId });
}
