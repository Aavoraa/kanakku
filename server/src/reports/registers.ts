import { many, maybeOne, one, type Db } from '../db/client';
import { notFound } from '../lib/errors';
import { addDays } from '../lib/dates';

export async function daybook(db: Db, companyId: string, from: string, to: string, opts: { type?: string; partyId?: string } = {}) {
  return many(db,
    `SELECT v.id, v.voucher_no AS "voucherNo", v.voucher_date::text AS date, t.base_type AS "voucherType", t.name AS "typeName",
            v.total_minor AS "totalMinor", v.source, v.narration, v.party_ref_no AS "partyRefNo",
            COALESCE(cp.legal_name, (
              SELECT l.name FROM ledger_entries e JOIN ledgers l ON l.id = e.ledger_id
               WHERE e.voucher_id = v.id ORDER BY (l.tax_component IS NOT NULL), (l.system_code IS NOT NULL), e.line_no LIMIT 1)) AS particulars,
            v.reverses_voucher_id AS "reversesVoucherId",
            (SELECT r.voucher_no FROM vouchers r WHERE r.reverses_voucher_id = v.id) AS "reversedBy"
       FROM vouchers v
       JOIN voucher_types t ON t.id = v.voucher_type_id
       LEFT JOIN counterparties cp ON cp.id = v.counterparty_id
      WHERE v.company_id = $1 AND v.voucher_date BETWEEN $2 AND $3 AND t.base_type <> 'OPENING'
        AND ($4::text IS NULL OR t.base_type = $4) AND ($5::uuid IS NULL OR v.counterparty_id = $5)
      ORDER BY v.voucher_date, v.chain_seq`, [companyId, from, to, opts.type ?? null, opts.partyId ?? null]);
}

export async function voucherDetail(db: Db, companyId: string, id: string) {
  const v = await maybeOne<Record<string, unknown>>(db,
    `SELECT v.id, v.voucher_no AS "voucherNo", v.voucher_date::text AS date, t.base_type AS "voucherType", t.name AS "typeName",
            v.total_minor AS "totalMinor", v.source, v.narration, v.party_ref_no AS "partyRefNo", v.party_ref_date::text AS "partyRefDate",
            v.original_ref AS "originalRef", v.place_of_supply AS "placeOfSupply", v.reverse_charge AS "reverseCharge",
            v.payment_mode AS "paymentMode", v.counterparty_id AS "counterpartyId", cp.legal_name AS "partyName", cp.gstin AS "partyGstin",
            v.reverses_voucher_id AS "reversesVoucherId", v.chain_seq AS "chainSeq", encode(v.row_hash, 'hex') AS "rowHash",
            v.posted_at AS "postedAt", v.input,
            (SELECT r.id FROM vouchers r WHERE r.reverses_voucher_id = v.id) AS "reversedById",
            (SELECT r.voucher_no FROM vouchers r WHERE r.reverses_voucher_id = v.id) AS "reversedByNo",
            (SELECT o.voucher_no FROM vouchers o WHERE o.id = v.reverses_voucher_id) AS "reversesNo"
       FROM vouchers v JOIN voucher_types t ON t.id = v.voucher_type_id
       LEFT JOIN counterparties cp ON cp.id = v.counterparty_id
      WHERE v.id = $1 AND v.company_id = $2`, [id, companyId]);
  if (!v) throw notFound('Voucher');
  const entries = await many(db,
    `SELECT e.line_no AS "lineNo", e.ledger_id AS "ledgerId", l.name AS "ledgerName", e.amount_minor AS "amountMinor",
            b.bill_ref AS "billRef", b.alloc_type AS "billType", b.due_date::text AS "dueDate"
       FROM ledger_entries e JOIN ledgers l ON l.id = e.ledger_id
       LEFT JOIN bill_allocations b ON b.ledger_entry_id = e.id
      WHERE e.voucher_id = $1 ORDER BY e.line_no`, [id]);
  const taxes = await many(db,
    `SELECT item_line_no AS "itemLineNo", hsn_sac AS "hsnSac", component, rate_ppm AS "ratePpm", taxable_minor AS "taxableMinor",
            tax_minor AS "taxMinor", direction, reverse_charge AS "reverseCharge", itc_eligible AS "itcEligible"
       FROM voucher_tax_lines WHERE voucher_id = $1 ORDER BY item_line_no, component`, [id]);
  const inventory = await many(db,
    `SELECT ie.line_no AS "lineNo", i.name AS "itemName", u.symbol AS uom, ie.qty::text AS qty, ie.unit_cost::text AS "unitCost", g.name AS godown
       FROM inventory_entries ie JOIN stock_items i ON i.id = ie.item_id JOIN uoms u ON u.id = i.base_uom_id
       JOIN godowns g ON g.id = ie.godown_id
      WHERE ie.voucher_id = $1 ORDER BY ie.line_no`, [id]);
  return { ...v, entries, taxes, inventory };
}

export async function ledgerStatement(db: Db, companyId: string, ledgerId: string, from: string, to: string) {
  const ledger = await maybeOne<{ id: string; name: string; group_name: string }>(db,
    `SELECT l.id, l.name, g.name AS group_name FROM ledgers l JOIN ledger_groups g ON g.id = l.group_id
      WHERE l.id = $1 AND l.company_id = $2`, [ledgerId, companyId]);
  if (!ledger) throw notFound('Ledger');
  const opening = await one<{ s: bigint }>(db,
    `SELECT COALESCE(SUM(amount_minor), 0)::bigint AS s FROM ledger_entries WHERE ledger_id = $1 AND voucher_date < $2`, [ledgerId, from]);
  const rows = await many<{ voucherId: string; date: string; voucherNo: string; voucherType: string; amountMinor: bigint; particulars: string | null; narration: string | null; billRef: string | null }>(db,
    `SELECT v.id AS "voucherId", e.voucher_date::text AS date, v.voucher_no AS "voucherNo", t.base_type AS "voucherType",
            e.amount_minor AS "amountMinor", v.narration, b.bill_ref AS "billRef",
            (SELECT CASE WHEN COUNT(*) = 1 THEN MIN(l2.name) ELSE '(as per details)' END
               FROM ledger_entries e2 JOIN ledgers l2 ON l2.id = e2.ledger_id
              WHERE e2.voucher_id = e.voucher_id AND e2.ledger_id <> e.ledger_id AND sign(e2.amount_minor) <> sign(e.amount_minor)) AS particulars
       FROM ledger_entries e
       JOIN vouchers v ON v.id = e.voucher_id
       JOIN voucher_types t ON t.id = v.voucher_type_id
       LEFT JOIN bill_allocations b ON b.ledger_entry_id = e.id
      WHERE e.ledger_id = $1 AND e.voucher_date BETWEEN $2 AND $3
      ORDER BY e.voucher_date, v.chain_seq, e.line_no`, [ledgerId, from, to]);
  let running = opening.s;
  const lines = rows.map((r) => {
    running += r.amountMinor;
    return { ...r, balanceMinor: running };
  });
  const debit = rows.reduce((s, r) => (r.amountMinor > 0n ? s + r.amountMinor : s), 0n);
  const credit = rows.reduce((s, r) => (r.amountMinor < 0n ? s - r.amountMinor : s), 0n);
  return {
    ledger: { id: ledger.id, name: ledger.name, group: ledger.group_name },
    from, to,
    openingMinor: opening.s,
    lines,
    totalDebitMinor: debit,
    totalCreditMinor: credit,
    closingMinor: running,
  };
}

/** Open bills per party for receivables (debtors) or payables (creditors). */
export async function ageing(db: Db, companyId: string, side: 'receivable' | 'payable', asOf: string) {
  const groupCode = side === 'receivable' ? 'SUNDRY_DEBTORS' : 'SUNDRY_CREDITORS';
  const sign = side === 'receivable' ? 1n : -1n;
  const bills = await many<{ ledger_id: string; party: string; counterparty_id: string | null; bill_ref: string; bill_date: string; due_date: string | null; open_minor: bigint }>(db,
    `WITH grp AS (SELECT path FROM ledger_groups WHERE company_id = $1 AND system_code = $3)
     SELECT ba.ledger_id, l.name AS party, l.counterparty_id, ba.bill_ref,
            MIN(ba.bill_date)::text AS bill_date,
            (MIN(COALESCE(ba.due_date, ba.bill_date)) FILTER (WHERE ba.alloc_type = 'NEW_REF'))::text AS due_date,
            SUM(ba.amount_minor)::bigint AS open_minor
       FROM bill_allocations ba
       JOIN ledger_entries e ON e.id = ba.ledger_entry_id
       JOIN ledgers l ON l.id = ba.ledger_id
       JOIN ledger_groups g ON g.id = l.group_id
      WHERE ba.company_id = $1 AND e.voucher_date <= $2 AND g.path <@ (SELECT path FROM grp)
      GROUP BY ba.ledger_id, l.name, l.counterparty_id, ba.bill_ref
     HAVING SUM(ba.amount_minor) <> 0
      ORDER BY l.name, MIN(ba.bill_date)`, [companyId, asOf, groupCode]);

  type Buckets = { notDue: bigint; d1_30: bigint; d31_60: bigint; d61_90: bigint; d90plus: bigint; unadjusted: bigint; total: bigint };
  const parties = new Map<string, { ledgerId: string; counterpartyId: string | null; party: string; buckets: Buckets; bills: unknown[] }>();
  const totals: Buckets = { notDue: 0n, d1_30: 0n, d31_60: 0n, d61_90: 0n, d90plus: 0n, unadjusted: 0n, total: 0n };
  for (const b of bills) {
    const amount = b.open_minor * sign;
    const p = parties.get(b.ledger_id) ?? {
      ledgerId: b.ledger_id, counterpartyId: b.counterparty_id, party: b.party, bills: [],
      buckets: { notDue: 0n, d1_30: 0n, d31_60: 0n, d61_90: 0n, d90plus: 0n, unadjusted: 0n, total: 0n },
    };
    let bucket: keyof Buckets;
    let overdue: number | null = null;
    if (!b.due_date) bucket = 'unadjusted';
    else {
      overdue = Math.round((Date.parse(asOf) - Date.parse(b.due_date)) / 864e5);
      bucket = overdue <= 0 ? 'notDue' : overdue <= 30 ? 'd1_30' : overdue <= 60 ? 'd31_60' : overdue <= 90 ? 'd61_90' : 'd90plus';
    }
    p.buckets[bucket] += amount; p.buckets.total += amount;
    totals[bucket] += amount; totals.total += amount;
    p.bills.push({ billRef: b.bill_ref, billDate: b.bill_date, dueDate: b.due_date, daysOverdue: overdue, amountMinor: amount, bucket });
    parties.set(b.ledger_id, p);
  }
  const rows = [...parties.values()].sort((a, b) => (b.buckets.total > a.buckets.total ? 1 : -1));
  return { side, asOf, parties: rows, totals };
}

export async function partyOutstanding(db: Db, companyId: string, counterpartyId: string, asOf: string, periodFrom: string) {
  const r = await ageing(db, companyId, 'receivable', asOf);
  const p = await ageing(db, companyId, 'payable', asOf);
  const match = [...r.parties, ...p.parties].find((x) => x.counterpartyId === counterpartyId);
  const ledger = await maybeOne<{ id: string }>(db, `SELECT id FROM ledgers WHERE counterparty_id = $1 AND company_id = $2`, [counterpartyId, companyId]);
  const balance = ledger
    ? (await one<{ s: bigint }>(db, `SELECT COALESCE(SUM(amount_minor), 0)::bigint AS s FROM ledger_entries WHERE ledger_id = $1 AND voucher_date <= $2`, [ledger.id, asOf])).s
    : 0n;
  const bills = (match?.bills ?? []) as { billDate: string; daysOverdue: number | null; amountMinor: bigint }[];
  return {
    balanceMinor: balance,                                     // + they owe us, - we owe them
    inPeriodMinor: bills.filter((b) => b.billDate >= periodFrom).reduce((s, b) => s + b.amountMinor, 0n),
    over60Minor: bills.filter((b) => (b.daysOverdue ?? 0) > 60).reduce((s, b) => s + b.amountMinor, 0n),
    openBills: bills.length,
  };
}

/** Open bill references for one party ledger (for Agst Ref pickers). */
export async function openBills(db: Db, companyId: string, ledgerId: string) {
  return many(db,
    `SELECT bill_ref AS "billRef", MIN(bill_date)::text AS "billDate", SUM(amount_minor)::bigint AS "openMinor"
       FROM bill_allocations WHERE company_id = $1 AND ledger_id = $2 AND alloc_type IN ('NEW_REF','AGST_REF')
      GROUP BY bill_ref HAVING SUM(amount_minor) <> 0 ORDER BY MIN(bill_date)`, [companyId, ledgerId]);
}

export const yesterday = (iso: string) => addDays(iso, -1);
