import Decimal from 'decimal.js';
import { parseAmount } from '../lib/parse';
import type { ParsedBill } from './bill-schema';

/**
 * A number the model wrote as text, read tolerantly: "1,250.00", "₹500", "10 Nos", "18%".
 * Null when there is no number, so one odd value becomes a gap for the reviewer instead of failing the document.
 */
export function dec(s: string | null | undefined): Decimal | null {
  if (s === null || s === undefined) return null;
  const direct = parseAmount(s);
  if (direct) return direct;
  const m = String(s).replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  return m ? new Decimal(m[0]) : null;
}

export function lineTaxable(l: ParsedBill['line_items'][number]): Decimal | null {
  const taxable = dec(l.taxable_value);
  if (taxable) return taxable;
  const qty = dec(l.quantity);
  const price = dec(l.unit_price);
  if (qty && price) return qty.times(price).minus(dec(l.discount) ?? 0);
  const total = dec(l.line_total);
  if (total) {
    const tax = [l.cgst, l.sgst, l.igst, l.cess].reduce((s, x) => s.plus(dec(x) ?? 0), new Decimal(0));
    return total.minus(tax);
  }
  return null;
}
