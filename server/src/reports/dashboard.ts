import { many, one, type Db } from '../db/client';
import { monthStart, resolvePeriod, shiftMonths, todayIST } from '../lib/dates';
import { ageing } from './registers';
import { gstSummary } from './gst';

async function groupBalance(db: Db, companyId: string, codes: string[], asOf: string): Promise<bigint> {
  const r = await one<{ s: bigint }>(db,
    `WITH grp AS (SELECT path FROM ledger_groups WHERE company_id = $1 AND system_code = ANY($2::text[]))
     SELECT COALESCE(SUM(e.amount_minor), 0)::bigint AS s
       FROM ledger_entries e JOIN ledgers l ON l.id = e.ledger_id JOIN ledger_groups g ON g.id = l.group_id
      WHERE e.company_id = $1 AND e.voucher_date <= $3 AND EXISTS (SELECT 1 FROM grp WHERE g.path <@ grp.path)`,
    [companyId, codes, asOf]);
  return r.s;
}

export async function typeTotal(db: Db, companyId: string, baseType: string, from: string, to: string): Promise<bigint> {
  // Net of reversals: a reversal carries the same total, so subtract it.
  const r = await one<{ s: bigint }>(db,
    `SELECT COALESCE(SUM(CASE WHEN v.reverses_voucher_id IS NULL THEN v.total_minor ELSE -v.total_minor END), 0)::bigint AS s
       FROM vouchers v JOIN voucher_types t ON t.id = v.voucher_type_id
      WHERE v.company_id = $1 AND t.base_type = $2 AND v.voucher_date BETWEEN $3 AND $4`, [companyId, baseType, from, to]);
  return r.s;
}

export async function cashBalance(db: Db, companyId: string, asOf: string) {
  return groupBalance(db, companyId, ['CASH_IN_HAND'], asOf);
}
export async function bankBalance(db: Db, companyId: string, asOf: string) {
  return groupBalance(db, companyId, ['BANK_ACCOUNTS', 'BANK_OD'], asOf);
}

/**
 * Sales and purchases for each of the last `n` months (this month to date included), net of reversals and of credit /
 * debit notes, for the dashboard chart.
 */
export async function monthlyTrading(db: Db, companyId: string, today: string, n = 6) {
  const months = Array.from({ length: n }, (_, i) => shiftMonths(monthStart(today), i - (n - 1)));
  const rows = await many<{ m: string; base: string; s: bigint }>(db,
    `SELECT to_char(v.voucher_date, 'YYYY-MM') AS m, t.base_type AS base,
            SUM(CASE WHEN v.reverses_voucher_id IS NULL THEN v.total_minor ELSE -v.total_minor END)::bigint AS s
       FROM vouchers v JOIN voucher_types t ON t.id = v.voucher_type_id
      WHERE v.company_id = $1 AND t.base_type IN ('SALES','CREDIT_NOTE','PURCHASE','DEBIT_NOTE') AND v.voucher_date BETWEEN $2 AND $3
      GROUP BY 1, 2`, [companyId, months[0], today]);
  const sum = (m: string, base: string) => rows.find((r) => r.m === m && r.base === base)?.s ?? 0n;
  return months.map((start) => {
    const m = start.slice(0, 7);
    return { month: m, salesMinor: sum(m, 'SALES') - sum(m, 'CREDIT_NOTE'), purchasesMinor: sum(m, 'PURCHASE') - sum(m, 'DEBIT_NOTE') };
  });
}

export async function dashboard(db: Db, companyId: string) {
  const today = todayIST();
  const month = resolvePeriod('THIS_MONTH', today);
  const recv = await ageing(db, companyId, 'receivable', today);
  const pay = await ageing(db, companyId, 'payable', today);
  const gst = await gstSummary(db, companyId, month.from, month.to);
  const pending = await one<{ n: bigint }>(db,
    `SELECT COUNT(*)::bigint AS n FROM documents WHERE company_id = $1 AND status IN ('RECEIVED','PROCESSING','NEEDS_REVIEW')`, [companyId]);
  const recent = await many(db,
    `SELECT v.id, v.voucher_no AS "voucherNo", v.voucher_date::text AS date, t.base_type AS "voucherType",
            v.total_minor AS "totalMinor", v.source,
            COALESCE(cp.legal_name, (
              SELECT l.name FROM ledger_entries e JOIN ledgers l ON l.id = e.ledger_id
               WHERE e.voucher_id = v.id ORDER BY (l.tax_component IS NOT NULL), (l.system_code IS NOT NULL), e.line_no LIMIT 1)) AS party
       FROM vouchers v JOIN voucher_types t ON t.id = v.voucher_type_id
       LEFT JOIN counterparties cp ON cp.id = v.counterparty_id
      WHERE v.company_id = $1 AND t.base_type <> 'OPENING'
      ORDER BY v.chain_seq DESC LIMIT 8`, [companyId]);
  return {
    today,
    cashMinor: await cashBalance(db, companyId, today),
    bankMinor: await bankBalance(db, companyId, today),
    receivablesMinor: recv.totals.total,
    receivablesOver60Minor: recv.totals.d61_90 + recv.totals.d90plus,
    payablesMinor: pay.totals.total,
    salesTodayMinor: await typeTotal(db, companyId, 'SALES', today, today),
    salesMonthMinor: await typeTotal(db, companyId, 'SALES', month.from, month.to),
    purchasesMonthMinor: await typeTotal(db, companyId, 'PURCHASE', month.from, month.to),
    gstPayableMonthMinor: gst.netPayableMinor,
    pendingDocuments: Number(pending.n),
    months: await monthlyTrading(db, companyId, today),
    recent,
  };
}
