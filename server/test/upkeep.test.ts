import { beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { one, openDb } from '../src/db/client';
import { createCompany, createItem, createLedger, createParty, groupByCode } from '../src/ledger/masters';
import { postVoucher, reverseVoucher } from '../src/ledger/post';
import { countCash, createBox, listBoxes, pettyCashBook, recordExpense, topUp } from '../src/pettycash/service';
import { renameGroup, updateItem, updateLedger, updateParty } from '../src/ledger/alter';
import { addSchedule, assetDetail, createAsset, listAssets, logUpkeep, updateAsset } from '../src/assets/service';
import { complianceAlerts, complianceItems } from '../src/compliance/service';
import { closeYear, healthCheck, yearClosePreview } from '../src/upkeep/service';
import { createGroup } from '../src/ledger/masters';
import { makeGstin } from '../src/lib/gstin';
import { config } from '../src/config';

const user = config.localUserId;
let db: PGlite;
let companyId: string;
let bank: string;
let seq = 0;
const key = () => `u-${++seq}`;
const bal = async (ledgerId: string) => (await one<{ s: bigint }>(db, `SELECT COALESCE(SUM(amount_minor), 0)::bigint AS s FROM ledger_entries WHERE ledger_id = $1`, [ledgerId])).s;
const ledgerByName = async (name: string) => (await one<{ id: string }>(db, `SELECT id FROM ledgers WHERE company_id = $1 AND name = $2`, [companyId, name])).id;

beforeAll(async () => {
  db = await openDb();
  companyId = await createCompany(db, { name: 'Upkeep Traders', stateCode: '33', gstin: makeGstin('33', 'AAAFU1234K'), booksFrom: '2025-04-01' });
  const bankGroup = await groupByCode(db, companyId, 'BANK_ACCOUNTS');
  bank = (await createLedger(db, companyId, { name: 'HDFC Bank', groupId: bankGroup.id, openingBalance: '500000', openingSide: 'DR' }, user)).id;
}, 60_000);

describe('petty cash (imprest)', () => {
  let box = '';
  let petty = '';
  let office = '';

  it('sets up a box with its float, funded from the bank', async () => {
    const r = await createBox(db, companyId, { name: 'Petty Cash', custodian: 'Ravi', floatAmount: '10,000', fundFromLedgerId: bank, date: '2026-04-01' }, user);
    box = r.id; petty = r.ledgerId;
    expect(r.funded?.voucherType).toBe('CONTRA');
    expect(await bal(petty)).toBe(1_000_000n);
    office = (await createLedger(db, companyId, { name: 'Office Expenses', groupId: (await groupByCode(db, companyId, 'INDIRECT_EXPENSES')).id }, user)).id;
  });

  it('pays an expense without GST as a Payment, and one with GST as a Purchase with input credit', async () => {
    const p = await recordExpense(db, companyId, box, { date: '2026-04-05', expenseLedgerId: office, amount: '450', paidTo: 'Tea stall' }, { idempotencyKey: key(), userId: user });
    expect(p.voucherType).toBe('PAYMENT');
    const g = await recordExpense(db, companyId, box, { date: '2026-04-06', expenseLedgerId: office, amount: '1180', gstRate: '18', paidTo: 'Stationers', billNo: 'S-91' }, { idempotencyKey: key(), userId: user });
    expect(g.voucherType).toBe('PURCHASE');
    expect(await bal(petty)).toBe(1_000_000n - 45_000n - 118_000n);
    expect(await bal(await ledgerByName('Input CGST 9%'))).toBe(9_000n);
  });

  it('asks to confirm a payment above the per-payment limit', async () => {
    const e = { date: '2026-04-07', expenseLedgerId: office, amount: '6000', paidTo: 'Electrician' };
    await expect(recordExpense(db, companyId, box, e, { idempotencyKey: key(), userId: user })).rejects.toMatchObject({ code: 'CONFIRM_WARNINGS' });
    expect((await recordExpense(db, companyId, box, { ...e, confirmWarnings: true }, { idempotencyKey: key(), userId: user })).alreadyPosted).toBe(false);
  });

  it('refuses to pay out more than the box holds, including on later days', async () => {
    // Holds 2,370 now. A backdated payment of 2,500 on 2 April would leave 7 April short.
    await expect(recordExpense(db, companyId, box, { date: '2026-04-02', expenseLedgerId: office, amount: '2500' }, { idempotencyKey: key(), userId: user }))
      .rejects.toMatchObject({ code: 'PETTY_CASH_SHORT' });
  });

  it('flags the box as low in the bell, and tops it back up to the float', async () => {
    expect((await complianceAlerts(db, companyId)).items.some((i) => i.kind === 'PETTY_LOW' && i.link === 'petty-cash')).toBe(true);
    const t = await topUp(db, companyId, box, { date: '2026-04-08', fromLedgerId: bank }, { idempotencyKey: key(), userId: user });
    expect(t.totalMinor).toBe(763_000n);                       // spent 450 + 1,180 + 6,000
    expect(await bal(petty)).toBe(1_000_000n);
    await expect(topUp(db, companyId, box, { date: '2026-04-08', fromLedgerId: bank }, { idempotencyKey: key(), userId: user })).rejects.toMatchObject({ code: 'PETTY_CASH_FULL' });
    expect((await listBoxes(db, companyId))[0]).toMatchObject({ low: false, topUpMinor: 0n });
  });

  it('counts the cash note by note and posts a shortage', async () => {
    // 19 x 500 + 4 x 100 + 1 x 50 + 40 in coins = 9,990 against 10,000 in the books.
    const c = await countCash(db, companyId, box, { date: '2026-04-08', notes: { 500: 19, 100: 4, 50: 1 }, coins: '40', postDifference: true }, { idempotencyKey: key(), userId: user });
    expect(c).toMatchObject({ countedMinor: 999_000n, bookMinor: 1_000_000n, differenceMinor: -1_000n });
    expect(c.adjustment?.voucherType).toBe('PAYMENT');
    expect(await bal(petty)).toBe(999_000n);
    expect(await bal(await ledgerByName('Petty Cash Short / Excess'))).toBe(1_000n);
  });

  it('shows the petty cash book with spending by head and the counts', async () => {
    const b = await pettyCashBook(db, companyId, box, '2026-04-01', '2026-04-30');
    expect(b.closingMinor).toBe(999_000n);
    expect(b.byHead.find((h) => h.ledger === 'Office Expenses')?.amountMinor).toBe(45_000n + 100_000n + 600_000n);
    expect(b.counts).toHaveLength(1);
  });
});

describe('altering masters', () => {
  it('renames and switches off a ledger, and refuses new entries to it', async () => {
    const group = await groupByCode(db, companyId, 'INDIRECT_EXPENSES');
    const l = (await createLedger(db, companyId, { name: 'Conveyance', groupId: group.id }, user)).id;
    await updateLedger(db, companyId, l, { name: 'Travel & Conveyance' }, user);
    await expect(updateLedger(db, companyId, l, { name: 'Office Expenses' }, user)).rejects.toMatchObject({ code: 'DUPLICATE_NAME' });
    await updateLedger(db, companyId, l, { active: false }, user);
    await expect(postVoucher(db, companyId, { voucherType: 'PAYMENT', date: '2026-04-09', entries: [{ ledgerId: l, side: 'DR', amount: '10' }, { ledgerId: bank, side: 'CR', amount: '10' }] },
      { source: 'MANUAL', idempotencyKey: key(), userId: user })).rejects.toMatchObject({ code: 'LEDGER_INACTIVE' });
    await updateLedger(db, companyId, l, { active: true }, user);
  });

  it('will not switch off a ledger with a balance, nor move a standard ledger', async () => {
    await expect(updateLedger(db, companyId, bank, { active: false }, user)).rejects.toMatchObject({ code: 'HAS_BALANCE' });
    const cash = await ledgerByName('Cash');
    await expect(updateLedger(db, companyId, cash, { groupId: (await groupByCode(db, companyId, 'BANK_ACCOUNTS')).id }, user)).rejects.toThrow(/standard ledger/);
  });

  it('edits a party: rename, GSTIN (state follows it), customer to supplier; no switching off with a balance', async () => {
    const p = await createParty(db, companyId, { name: 'Kumar Stores', kind: 'CUSTOMER', stateCode: '33' }, user);
    const gstin = makeGstin('29', 'AAAPK1234Q');
    const r = await updateParty(db, companyId, p.id, { name: 'Kumar Stores Pvt Ltd', gstin, kind: 'SUPPLIER', creditDays: 30 }, user);
    expect(r).toMatchObject({ name: 'Kumar Stores Pvt Ltd', stateCode: '29', regType: 'REGULAR', creditDays: 30 });
    expect((await one<{ name: string }>(db, `SELECT name FROM ledgers WHERE id = $1`, [p.ledgerId])).name).toBe('Kumar Stores Pvt Ltd');
    const creditors = await groupByCode(db, companyId, 'SUNDRY_CREDITORS');
    expect((await one<{ group_id: string }>(db, `SELECT group_id FROM ledgers WHERE id = $1`, [p.ledgerId])).group_id).toBe(creditors.id);
    await postVoucher(db, companyId, { voucherType: 'PURCHASE', date: '2026-04-10', counterpartyId: p.id, partyRefNo: 'K-1', items: [{ amount: '1000', gstRate: '0' }] },
      { source: 'MANUAL', idempotencyKey: key(), userId: user });
    await expect(updateParty(db, companyId, p.id, { active: false }, user)).rejects.toMatchObject({ code: 'HAS_BALANCE' });
  });

  it('edits an item; unit and valuation are fixed once it has moved; no switching off with stock', async () => {
    const uom = (await one<{ id: string }>(db, `SELECT id FROM uoms WHERE company_id = $1 AND symbol = 'Nos'`, [companyId])).id;
    const it = (await createItem(db, companyId, { name: 'Widget', uomId: uom }, user)).id;
    await updateItem(db, companyId, it, { name: 'Widget A', hsnSac: '8481', gstRate: '18', valuation: 'FIFO' }, user);
    await postVoucher(db, companyId, { voucherType: 'PURCHASE', date: '2026-04-10', paymentMode: 'CASH', items: [{ itemId: it, qty: '2', amount: '200', gstRate: '0' }] },
      { source: 'MANUAL', idempotencyKey: key(), userId: user });
    await expect(updateItem(db, companyId, it, { valuation: 'WAVG' }, user)).rejects.toThrow(/cannot change/);
    await expect(updateItem(db, companyId, it, { active: false }, user)).rejects.toMatchObject({ code: 'HAS_STOCK' });
  });

  it('renames own groups but not the standard ones', async () => {
    const parent = await groupByCode(db, companyId, 'INDIRECT_EXPENSES');
    const g = await createGroup(db, companyId, { name: 'Admin costs', parentId: parent.id });
    expect((await renameGroup(db, companyId, g.id, 'Administration', user)).name).toBe('Administration');
    await expect(renameGroup(db, companyId, parent.id, 'Overheads', user)).rejects.toThrow(/standard group/);
  });
});

describe('asset upkeep', () => {
  it('keeps an asset with an AMC in the calendar, logs the service, posts its cost and ticks the reminder off', async () => {
    const a = await createAsset(db, companyId, { name: 'Generator', category: 'Plant', location: 'Godown', cost: '250000', purchaseDate: '2025-06-01' }, user);
    await addSchedule(db, companyId, a.id, { kind: 'AMC', nextDue: '2026-04-20', repeat: 'YEARLY', remindDays: 30 }, user);
    const items = await complianceItems(db, companyId, '2026-04-01', '2026-04-30', '2026-04-10');
    const amc = items.find((i) => i.kind === 'ASSET')!;
    expect(amc).toMatchObject({ title: 'Generator — AMC renewal', status: 'DUE_SOON', link: 'assets' });
    const r = await logUpkeep(db, companyId, a.id, { date: '2026-04-15', kind: 'AMC', description: 'AMC renewed for a year', cost: '2360', gstRate: '18', paidFromLedgerId: bank, vendor: 'PowerCare', scheduleKey: amc.key },
      { idempotencyKey: key(), userId: user });
    expect(r.voucher?.voucherNo).toBeTruthy();
    expect((await complianceItems(db, companyId, '2026-04-01', '2026-04-30', '2026-04-16')).find((i) => i.key === amc.key)?.status).toBe('DONE');
    expect(await bal(await ledgerByName('Repairs & Maintenance'))).toBe(200_000n);       // 2,360 incl. 18% GST
    const d = await assetDetail(db, companyId, a.id);
    expect(d.logs).toHaveLength(1);
    expect((await listAssets(db, companyId)).find((x) => (x as { id: string }).id === a.id)).toMatchObject({ upkeepMinor: 236_000n });
  });

  it('retiring an asset stops its reminders', async () => {
    const a = await createAsset(db, companyId, { name: 'Old printer' }, user);
    await addSchedule(db, companyId, a.id, { kind: 'SERVICE', nextDue: '2026-05-01', repeat: 'QUARTERLY' }, user);
    await updateAsset(db, companyId, a.id, { active: false }, user);
    expect((await complianceItems(db, companyId, '2026-04-01', '2026-12-31')).some((i) => i.title.startsWith('Old printer'))).toBe(false);
  });
});

describe('app upkeep', () => {
  it('health check passes, and finds cash paid out before it came in', async () => {
    const checks = await healthCheck(db, companyId, { isAdmin: false });
    expect(checks.find((c) => c.id === 'chain')?.level).toBe('ok');
    expect(checks.find((c) => c.id === 'balance')?.level).toBe('ok');
    const cash = await ledgerByName('Cash');
    const rent = (await createLedger(db, companyId, { name: 'Rent', groupId: (await groupByCode(db, companyId, 'INDIRECT_EXPENSES')).id }, user)).id;
    const v = await postVoucher(db, companyId, { voucherType: 'PAYMENT', date: '2026-04-03', entries: [{ ledgerId: rent, side: 'DR', amount: '99999' }, { ledgerId: cash, side: 'CR', amount: '99999' }] },
      { source: 'MANUAL', idempotencyKey: key(), userId: user });
    expect((await healthCheck(db, companyId, { isAdmin: false })).find((c) => c.id === 'cash')).toMatchObject({ level: 'warn' });
    await reverseVoucher(db, companyId, v.id, { userId: user, source: 'MANUAL' });
  });

  it('closes a finished year: locks it, and nothing more can be posted into it', async () => {
    await postVoucher(db, companyId, { voucherType: 'SALES', date: '2026-02-10', paymentMode: 'CASH', items: [{ amount: '5000', gstRate: '0' }] },
      { source: 'MANUAL', idempotencyKey: key(), userId: user });
    await expect(yearClosePreview(db, companyId, '2026-02-28')).rejects.toThrow(/last day of a financial year/);
    const p = await yearClosePreview(db, companyId, '2026-03-31');
    expect(p.blockers).toEqual([]);
    expect(p.netProfitMinor).toBe(500_000n);
    const r = await closeYear(db, companyId, '2026-03-31', user);
    expect(r.lockDate).toBe('2026-03-31');
    await expect(postVoucher(db, companyId, { voucherType: 'SALES', date: '2026-03-15', paymentMode: 'CASH', items: [{ amount: '100', gstRate: '0' }] },
      { source: 'MANUAL', idempotencyKey: key(), userId: user })).rejects.toMatchObject({ code: 'PERIOD_LOCKED' });
  });
});
