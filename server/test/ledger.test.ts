import { beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { openDb, one } from '../src/db/client';
import { seedDemo } from '../src/db/demo';
import { postVoucher, previewVoucher, reverseVoucher, verifyChain } from '../src/ledger/post';
import { balanceSheet, profitAndLoss, trialBalance } from '../src/reports/financials';
import { ageing, ledgerStatement } from '../src/reports/registers';
import { gstSummary } from '../src/reports/gst';
import { dashboard } from '../src/reports/dashboard';
import { stockAsOf } from '../src/inventory/stock';
import { todayIST, fyStart } from '../src/lib/dates';
import { config } from '../src/config';

let db: PGlite;
let companyId: string;
const user = config.localUserId;
const today = todayIST();
const ids = async () => ({
  cash: (await one<{ id: string }>(db, `SELECT id FROM ledgers WHERE company_id = $1 AND system_code = 'CASH'`, [companyId])).id,
  rajesh: (await one<{ id: string }>(db, `SELECT id FROM counterparties WHERE company_id = $1 AND legal_name = 'Rajesh Traders'`, [companyId])).id,
  balaji: (await one<{ id: string }>(db, `SELECT id FROM counterparties WHERE company_id = $1 AND legal_name = 'Shree Balaji Cement Agency'`, [companyId])).id,
  cement: (await one<{ id: string }>(db, `SELECT id FROM stock_items WHERE company_id = $1 AND name LIKE 'Cement%'`, [companyId])).id,
});

beforeAll(async () => {
  db = await openDb();
  companyId = await seedDemo(db);
}, 60_000);

describe('posting engine', () => {
  it('posts the spec voice example as four balanced lines', async () => {
    const { rajesh, cement } = await ids();
    const preview = await previewVoucher(db, companyId, {
      voucherType: 'SALES', date: today, counterpartyId: rajesh, paymentMode: 'CASH', pricesIncludeTax: true,
      items: [{ itemId: cement, qty: '10', amount: '5500', gstRate: '18' }],
    });
    expect(preview.totalMinor).toBe(550000n);
    expect(preview.entries.map((e) => [e.ledgerName, e.amountMinor])).toEqual([
      ['Cash', 550000n], ['Sales', -466102n], ['Output CGST 9%', -41949n], ['Output SGST 9%', -41949n],
    ]);
  });

  it('reports the invoice value as the total even when round-off is debited', async () => {
    const { cement } = await ids();
    // 4150 incl. 18%: taxable 3516.95 + 316.53 x 2 = 4150.01, so 0.01 is debited to Round Off.
    const p = await previewVoucher(db, companyId, {
      voucherType: 'SALES', date: today, paymentMode: 'CASH', pricesIncludeTax: true,
      items: [{ itemId: cement, qty: '10', amount: '4150', gstRate: '18' }],
    });
    expect(p.roundOffMinor).toBe(-1n);
    expect(p.totalMinor).toBe(415000n);
  });

  it('keeps the ledger balanced and the chain intact after seeding', async () => {
    const tb = await trialBalance(db, companyId, today);
    expect(tb.totalDebitMinor).toBe(tb.totalCreditMinor);
    expect((await verifyChain(db, companyId)).ok).toBe(true);
  });

  it('refuses to update or delete posted rows', async () => {
    await expect(db.query(`UPDATE ledger_entries SET amount_minor = 1`)).rejects.toThrow(/append-only/);
    await expect(db.query(`DELETE FROM vouchers`)).rejects.toThrow(/append-only/);
  });

  it('rejects an unbalanced voucher at commit even if code is bypassed', async () => {
    await expect(db.transaction(async (tx) => {
      const v = await one<{ id: string }>(tx, `SELECT id FROM vouchers WHERE company_id = $1 LIMIT 1`, [companyId]);
      const l = await one<{ id: string }>(tx, `SELECT id FROM ledgers WHERE company_id = $1 LIMIT 1`, [companyId]);
      await tx.query(`INSERT INTO ledger_entries (company_id, voucher_id, line_no, ledger_id, amount_minor, voucher_date) VALUES ($1,$2,99,$3,100,$4)`, [companyId, v.id, l.id, today]);
    })).rejects.toThrow(/unbalanced/);
  });

  it('blocks a duplicate supplier bill and allows it after reversal', async () => {
    const { balaji, cement } = await ids();
    const input = { voucherType: 'PURCHASE', date: today, counterpartyId: balaji, partyRefNo: 'SBC/9999', items: [{ itemId: cement, qty: '5', amount: '1700', gstRate: '18' }] };
    const first = await postVoucher(db, companyId, input, { source: 'MANUAL', idempotencyKey: 'dup-1', userId: user });
    await expect(postVoucher(db, companyId, input, { source: 'MANUAL', idempotencyKey: 'dup-2', userId: user }))
      .rejects.toMatchObject({ code: 'DUPLICATE_BILL' });
    // Same idempotency key returns the original instead of posting twice.
    const again = await postVoucher(db, companyId, input, { source: 'MANUAL', idempotencyKey: 'dup-1', userId: user });
    expect(again).toMatchObject({ id: first.id, alreadyPosted: true });

    await reverseVoucher(db, companyId, first.id, { userId: user, source: 'MANUAL' });
    await expect(reverseVoucher(db, companyId, first.id, { userId: user, source: 'MANUAL' })).rejects.toMatchObject({ code: 'ALREADY_REVERSED' });
    const re = await postVoucher(db, companyId, input, { source: 'MANUAL', idempotencyKey: 'dup-3', userId: user });
    expect(re.alreadyPosted).toBe(false);
    expect((await verifyChain(db, companyId)).ok).toBe(true);
  });

  it('blocks selling more stock than is on hand', async () => {
    const { rajesh, cement } = await ids();
    await expect(postVoucher(db, companyId, {
      voucherType: 'SALES', date: today, counterpartyId: rajesh, items: [{ itemId: cement, qty: '100000', amount: '1', gstRate: '18' }],
    }, { source: 'MANUAL', idempotencyKey: 'neg', userId: user })).rejects.toMatchObject({ code: 'NEGATIVE_STOCK' });
  });

  it('asks for confirmation when a sale is booked to a supplier', async () => {
    const { balaji, cement } = await ids();
    await expect(postVoucher(db, companyId, {
      voucherType: 'SALES', date: today, counterpartyId: balaji, items: [{ itemId: cement, qty: '1', amount: '400', gstRate: '18' }],
    }, { source: 'MANUAL', idempotencyKey: 'mismatch', userId: user })).rejects.toMatchObject({ code: 'CONFIRM_WARNINGS' });
  });

  it('validates payment, contra and journal rules', async () => {
    const { cash } = await ids();
    const rent = (await one<{ id: string }>(db, `SELECT id FROM ledgers WHERE company_id = $1 AND name = 'Rent'`, [companyId])).id;
    await expect(postVoucher(db, companyId, { voucherType: 'JOURNAL', date: today, entries: [
      { ledgerId: rent, side: 'DR', amount: '10' }, { ledgerId: cash, side: 'CR', amount: '10' }] },
      { source: 'MANUAL', idempotencyKey: 'j1', userId: user })).rejects.toMatchObject({ code: 'JOURNAL_NO_CASH_BANK' });
    await expect(postVoucher(db, companyId, { voucherType: 'PAYMENT', date: today, entries: [
      { ledgerId: rent, side: 'DR', amount: '10' }, { ledgerId: cash, side: 'CR', amount: '9' }] },
      { source: 'MANUAL', idempotencyKey: 'p1', userId: user })).rejects.toMatchObject({ code: 'UNBALANCED' });
  });
});

describe('reports', () => {
  it('balance sheet balances, with stock and profit carried', async () => {
    const bs = await balanceSheet(db, companyId, today);
    expect(bs.differenceMinor).toBe(0n);
    expect(bs.totalAssetsMinor).toBeGreaterThan(0n);
  });

  it('P&L gross profit reflects closing stock', async () => {
    const pl = await profitAndLoss(db, companyId, fyStart(today), today);
    expect(pl.closingStockMinor).toBeGreaterThan(0n);
    expect(pl.grossProfitMinor).toBeGreaterThan(0n);
  });

  it('ageing, ledger statement, GST and dashboard run', async () => {
    const r = await ageing(db, companyId, 'receivable', today);
    expect(r.parties.find((p) => p.party === 'ABC Corp')!.buckets.total).toBe(16048000n); // (1200 + 800) kg x Rs 68 x 1.18 IGST
    const { cash } = await ids();
    const st = await ledgerStatement(db, companyId, cash, fyStart(today), today);
    expect(st.closingMinor).toBe(st.openingMinor + st.totalDebitMinor - st.totalCreditMinor);
    const g = await gstSummary(db, companyId, fyStart(today), today);
    expect(g.byComponent.find((c) => c.component === 'IGST')).toBeTruthy();
    const dash = await dashboard(db, companyId);
    expect(dash.receivablesMinor).toBeGreaterThan(0n);
    // Six months for the home chart, oldest first, ending with this month; the sample company has sales in them.
    expect(dash.months).toHaveLength(6);
    expect(dash.months.at(-1)!.month).toBe(today.slice(0, 7));
    expect(dash.months.some((m) => m.salesMinor > 0n)).toBe(true);
    const stock = await stockAsOf(db, companyId, today);
    expect(stock.find((s) => s.name.startsWith('TMT'))!.qty).toBe('1000');
  });
});
