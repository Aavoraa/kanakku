import Decimal from 'decimal.js';
import { maybeOne, type Db } from '../db/client';
import { fiscalYear, todayIST } from '../lib/dates';
import { isValidGstin, gstinState, stateCodeFrom } from '../lib/gstin';
import { percentToPpm } from '../lib/money';
import { KNOWN_GST_RATES_PPM } from '../tax/india-gst';
import { wordsToNumber } from './voice/normalize';
import type { ParsedBill } from './bill-schema';
import { lineTaxable } from './bill-numbers';
import type { Company } from '../ledger/context';

export interface Issue {
  code: string;
  field: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
}

const num = (s: string | null | undefined): Decimal | null => {
  if (s === null || s === undefined || s === '') return null;
  try { return new Decimal(s.replace(/,/g, '')); } catch { return null; }
};
const sum = (xs: (Decimal | null)[]) => xs.reduce<Decimal>((s, x) => (x ? s.plus(x) : s), new Decimal(0));

export interface BillContext { role: 'received' | 'issued'; voucherType: string }

export async function validateBill(db: Db, company: Company, bill: ParsedBill, matchedPartyId: string | null, recomputedTotal: Decimal | null,
  bc: BillContext = { role: 'received', voucherType: 'PURCHASE' }): Promise<Issue[]> {
  const issues: Issue[] = [];
  const add = (severity: Issue['severity'], code: string, field: string, message: string) => issues.push({ severity, code, field, message });

  if (bill.document_type === 'NOT_A_BILL') add('error', 'NOT_A_BILL', 'document_type', 'This does not look like a bill or receipt.');

  const sg = bill.supplier.gstin.value?.toUpperCase() ?? null;
  if (sg && !isValidGstin(sg)) add('error', 'GSTIN_INVALID', 'supplier.gstin', `Supplier GSTIN ${sg} fails the format or check-digit test; it may be misread.`);
  if (sg && isValidGstin(sg)) {
    const printed = stateCodeFrom(bill.supplier.state);
    if (printed && printed !== gstinState(sg)) add('warning', 'GSTIN_STATE_MISMATCH', 'supplier.state', `GSTIN is registered in state ${gstinState(sg)} but the printed state is ${printed}.`);
  }
  const bg = bill.buyer.gstin.value?.toUpperCase() ?? null;
  if (bc.role === 'received' && bg && company.gstin && bg !== company.gstin) add('warning', 'BUYER_NOT_COMPANY', 'buyer.gstin', `Bill is addressed to GSTIN ${bg}, not yours (${company.gstin}); input credit may not be available.`);
  if (bc.role === 'issued' && sg && company.gstin && sg !== company.gstin) add('warning', 'ISSUER_NOT_COMPANY', 'supplier.gstin', `This invoice was issued by GSTIN ${sg}, not yours (${company.gstin}).`);
  if (bc.role === 'issued' && bg && !isValidGstin(bg)) add('error', 'GSTIN_INVALID', 'buyer.gstin', `Customer GSTIN ${bg} fails the format or check-digit test; it may be misread.`);

  // Line arithmetic: qty x price - discount = taxable value (within Rs 0.50).
  bill.line_items.forEach((l, i) => {
    const q = num(l.quantity), p = num(l.unit_price), t = num(l.taxable_value);
    if (q && p && t) {
      const expected = q.times(p).minus(num(l.discount) ?? 0);
      if (expected.minus(t).abs().gt(0.5)) add('warning', 'LINE_MATH', `line_items.${i}`, `Line ${i + 1}: ${q} x ${p} = ${expected.toFixed(2)}, but taxable value reads ${t.toFixed(2)}.`);
    }
    const r = l.gst_rate_percent;
    if (r && !KNOWN_GST_RATES_PPM.has(percentToPpm(r))) add('warning', 'RATE_UNUSUAL', `line_items.${i}`, `Line ${i + 1}: ${r}% is not a standard GST rate.`);
  });

  // Invoice arithmetic.
  const grand = num(bill.totals.grand_total.value);
  if (!grand) add('error', 'TOTAL_MISSING', 'totals.grand_total', 'Grand total could not be read.');
  // Lines that print only quantity x price, or only a line total, count too (as the draft does).
  const taxable = sum(bill.line_items.map((l) => lineTaxable(l)));
  const charges = sum(bill.charges.map((c) => num(c.amount)));
  const lineTax = sum(bill.line_items.flatMap((l) => [num(l.cgst), num(l.sgst), num(l.igst), num(l.cess)]));
  const summaryTax = sum(bill.tax_summary.flatMap((r) => [num(r.cgst), num(r.sgst), num(r.igst), num(r.cess)]));
  const tax = num(bill.totals.tax_total) ?? (summaryTax.gt(0) ? summaryTax : lineTax);
  if (grand && taxable.gt(0)) {
    // Taxable values are already net of line discounts.
    const computed = taxable.plus(charges).plus(tax).plus(num(bill.totals.round_off) ?? 0);
    if (computed.minus(grand).abs().gt(1)) add('error', 'TOTAL_MISMATCH', 'totals.grand_total', `Lines + charges + tax = ${computed.toFixed(2)}, but the grand total reads ${grand.toFixed(2)}.`);
  }

  // Tax split must fit intra/inter-state supply.
  // Intra-state when seller and place of supply are in the same state. For our own invoices the seller is us
  // and the place of supply is the customer's state.
  const supplierState = bc.role === 'issued'
    ? (stateCodeFrom(bill.place_of_supply) ?? (bg && isValidGstin(bg) ? gstinState(bg) : stateCodeFrom(bill.buyer.state)))
    : sg && isValidGstin(sg) ? gstinState(sg) : stateCodeFrom(bill.supplier.state);
  const igst = sum(bill.line_items.map((l) => num(l.igst))).plus(sum(bill.tax_summary.map((r) => num(r.igst))));
  const cgst = sum(bill.line_items.map((l) => num(l.cgst))).plus(sum(bill.tax_summary.map((r) => num(r.cgst))));
  const sgst = sum(bill.line_items.map((l) => num(l.sgst))).plus(sum(bill.tax_summary.map((r) => num(r.sgst))));
  // Our own invoices are compared with our state. A bill we received is compared with its printed place of
  // supply, which is not always our state (a hotel stay in another state is CGST + SGST of that state).
  const compareWith = bc.role === 'issued' ? company.state_code : stateCodeFrom(bill.place_of_supply) ?? company.state_code;
  if (supplierState) {
    const intra = supplierState === compareWith;
    const who = bc.role === 'issued' ? 'Customer' : 'Supplier';
    if (intra && igst.gt(0)) add('error', 'TAX_SPLIT', 'line_items', `${who} is in your state but the document charges IGST; expected CGST + SGST.`);
    if (!intra && (cgst.gt(0) || sgst.gt(0))) add('error', 'TAX_SPLIT', 'line_items', `${who} is in another state but the document charges CGST/SGST; expected IGST.`);
  }
  if (cgst.minus(sgst).abs().gt(0.05)) add('warning', 'CGST_SGST_DIFFER', 'line_items', `CGST (${cgst.toFixed(2)}) and SGST (${sgst.toFixed(2)}) should be equal.`);

  // Amount in words is a strong independent check when printed.
  if (grand && bill.totals.amount_in_words) {
    const words = wordsToNumber(bill.totals.amount_in_words);
    if (words !== null) {
      if (Math.floor(words) === grand.floor().toNumber()) add('info', 'WORDS_MATCH', 'totals.amount_in_words', 'Amount in words matches the grand total.');
      else add('warning', 'WORDS_MISMATCH', 'totals.amount_in_words', `Amount in words reads ${words}, grand total reads ${grand.toFixed(2)}.`);
    }
  }

  if (recomputedTotal && grand && recomputedTotal.minus(grand).abs().gt(1)) {
    add('warning', 'RECOMPUTE_MISMATCH', 'totals.grand_total', `Our tax engine computes ${recomputedTotal.toFixed(2)} for these lines; the bill says ${grand.toFixed(2)}.`);
  }

  // Dates.
  const date = bill.invoice_date.value;
  if (!date) add('error', 'DATE_MISSING', 'invoice_date', 'Invoice date could not be read.');
  else {
    if (date > todayIST()) add('error', 'DATE_FUTURE', 'invoice_date', `Invoice date ${date} is in the future.`);
    if (date < company.books_from) add('warning', 'DATE_BEFORE_BOOKS', 'invoice_date', `Invoice date ${date} is before your books begin (${company.books_from}).`);
    if (company.lock_date && date <= company.lock_date) add('error', 'PERIOD_LOCKED', 'invoice_date', `Books are locked up to ${company.lock_date}.`);
  }

  // Duplicate bill.
  const ref = bill.invoice_number.value;
  if (!ref) add('error', 'INVOICE_NO_MISSING', 'invoice_number', 'Invoice number could not be read.');
  if (ref && matchedPartyId && date) {
    const dup = await maybeOne<{ id: string; voucher_no: string }>(db,
      `SELECT v.id, v.voucher_no FROM vouchers v JOIN voucher_types t ON t.id = v.voucher_type_id
        WHERE v.company_id = $1 AND v.counterparty_id = $2 AND v.fiscal_year = $3 AND lower(v.party_ref_no) = lower($4)
          AND t.base_type = $5 AND v.reverses_voucher_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM vouchers r WHERE r.reverses_voucher_id = v.id)`,
      [company.id, matchedPartyId, fiscalYear(date, company.fy_start_month), ref.slice(0, 16), bc.voucherType]);
    if (dup) add('error', 'DUPLICATE_BILL', 'invoice_number', `Already booked as ${bc.voucherType.toLowerCase().replace('_', ' ')} ${dup.voucher_no}.`);
  }

  for (const w of bill.warnings) add('warning', `MODEL_${w}`, 'document', `Model noted: ${w.replace(/_/g, ' ').toLowerCase()}.`);
  return issues;
}
