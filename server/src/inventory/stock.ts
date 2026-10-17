import Decimal from 'decimal.js';
import { many, type Db } from '../db/client';
import { closing, type Move } from './valuation';
import { toMinor } from '../lib/money';

interface MoveRow {
  item_id: string;
  qty: string;
  unit_cost: string | null;
}

interface ItemRow {
  id: string;
  name: string;
  valuation: 'FIFO' | 'WAVG';
  allow_negative: boolean;
  uom: string;
  hsn_sac: string | null;
}

export interface StockLine {
  itemId: string;
  name: string;
  uom: string;
  hsnSac: string | null;
  method: 'FIFO' | 'WAVG';
  qty: string;
  valueMinor: bigint;
  rate: string;
}

/** Closing stock per item as of a date (periodic valuation, Tally model). */
export async function stockAsOf(db: Db, companyId: string, asOf: string, itemId?: string): Promise<StockLine[]> {
  const items = await many<ItemRow>(db,
    `SELECT i.id, i.name, i.valuation, i.allow_negative, u.symbol AS uom, i.hsn_sac
       FROM stock_items i JOIN uoms u ON u.id = i.base_uom_id
      WHERE i.company_id = $1 AND ($2::uuid IS NULL OR i.id = $2)
      ORDER BY i.name`, [companyId, itemId ?? null]);
  // A voucher reversed on or before the date is valued as if it was never posted: both it and its reversal
  // are left out. Replaying the reversal as an outward movement would take stock out at the running cost
  // rather than the cost it came in at, and leave closing stock overstated.
  const moves = await many<MoveRow>(db,
    `SELECT ie.item_id, ie.qty::text, ie.unit_cost::text
       FROM inventory_entries ie JOIN vouchers v ON v.id = ie.voucher_id
      WHERE ie.company_id = $1 AND ie.voucher_date <= $2 AND ($3::uuid IS NULL OR ie.item_id = $3)
        AND v.reverses_voucher_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM vouchers r WHERE r.reverses_voucher_id = ie.voucher_id AND r.voucher_date <= $2)
      ORDER BY ie.voucher_date, ie.chain_seq, ie.line_no`, [companyId, asOf, itemId ?? null]);
  const byItem = new Map<string, Move[]>();
  for (const m of moves) {
    const list = byItem.get(m.item_id) ?? [];
    list.push({ qty: new Decimal(m.qty), unitCost: m.unit_cost === null ? null : new Decimal(m.unit_cost) });
    byItem.set(m.item_id, list);
  }
  return items.map((it) => {
    // Reports always value, even if stock went negative historically.
    const c = closing(it.valuation, byItem.get(it.id) ?? [], true);
    const valueMinor = toMinor(c.value);
    return {
      itemId: it.id, name: it.name, uom: it.uom, hsnSac: it.hsn_sac, method: it.valuation,
      qty: c.qty.toString(),
      valueMinor,
      rate: c.qty.gt(0) ? c.value.div(c.qty).toDecimalPlaces(2).toFixed(2) : '0.00',
    };
  });
}

export async function stockValueMinor(db: Db, companyId: string, asOf: string): Promise<bigint> {
  return (await stockAsOf(db, companyId, asOf)).reduce((s, l) => s + l.valueMinor, 0n);
}

export async function qtyOnHand(db: Db, companyId: string, itemId: string, asOf: string): Promise<Decimal> {
  const r = await many<{ q: string | null }>(db,
    `SELECT SUM(qty)::text AS q FROM inventory_entries WHERE company_id = $1 AND item_id = $2 AND voucher_date <= $3`,
    [companyId, itemId, asOf]);
  return new Decimal(r[0]?.q ?? '0');
}
