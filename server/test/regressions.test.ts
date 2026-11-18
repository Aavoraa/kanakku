import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PGlite } from '@electric-sql/pglite';
import { many, one, openDb } from '../src/db/client';
import { buildApp } from '../src/app';
import { alterVoucher, postVoucher } from '../src/ledger/post';
import { createLedger, groupByCode } from '../src/ledger/masters';
import { countCash, createBox, recordExpense, topUp } from '../src/pettycash/service';
import { createAsset, logUpkeep } from '../src/assets/service';
import { complianceItems, saveRecord, updateComplianceSettings } from '../src/compliance/service';
import { isIsoDate } from '../src/lib/dates';
import { makeGstin } from '../src/lib/gstin';
import { config } from '../src/config';

const user = config.localUserId;
let db: PGlite;
let app: FastifyInstance;
let cookie = '';
let cid = '';
let bank = '';
let rent = '';
const api = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object, headers: Record<string, string> = {}) =>
  app.inject({ method, url: `/api/v1/companies/${cid}${url}`, payload, headers: { cookie, ...headers } });
const group = async (code: string) => (await groupByCode(db, cid, code)).id;
const payment = (date: string, amount: string) =>
  ({ voucherType: 'PAYMENT', date, entries: [{ ledgerId: rent, side: 'DR', amount }, { ledgerId: bank, side: 'CR', amount }] });

beforeAll(async () => {
  db = await openDb();
  app = await buildApp(db);
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/signup', payload: {
    name: 'Owner', email: 'fix@example.com', password: 'kanakku-2026', company: { name: 'Fix Co', gstin: makeGstin('33', 'AAPFF1234K'), booksFrom: '2026-04-01' },
  } });
  cookie = String(res.headers['set-cookie']).split(';')[0];
  cid = res.json().companyId;
  bank = (await createLedger(db, cid, { name: 'Axis Bank', groupId: await group('BANK_ACCOUNTS'), openingBalance: '100000' }, user)).id;
  rent = (await createLedger(db, cid, { name: 'Rent', groupId: await group('INDIRECT_EXPENSES') }, user)).id;
}, 60_000);

describe('opening balances only through the opening-balance path', () => {
  it('refuses an Opening voucher from the voucher routes', async () => {
    const sales = (await one<{ id: string }>(db, `SELECT id FROM ledgers WHERE company_id = $1 AND name = 'Sales'`, [cid])).id;
    const r = await api('POST', '/vouchers', { voucherType: 'OPENING', date: '2026-05-01', entries: [{ ledgerId: bank, side: 'DR', amount: '500' }, { ledgerId: sales, side: 'CR', amount: '500' }] },
      { 'idempotency-key': 'op-1' });
    expect(r.statusCode).toBe(422);
    expect(r.json().code).toBe('OPENING_NOT_ALLOWED');
  });

  it('sets an opening on the ledger (again, to a new figure) and refuses an amount that is not a number', async () => {
    expect((await api('POST', `/ledgers/${rent}/opening`, { amount: 'abc' })).statusCode).toBe(422);
    expect((await api('POST', `/ledgers/${bank}/opening`, { amount: '1,50,000' })).statusCode).toBe(200);
    const bal = await one<{ s: bigint }>(db, `SELECT SUM(amount_minor)::bigint AS s FROM ledger_entries WHERE ledger_id = $1`, [bank]);
    expect(bal.s).toBe(15_000_000n);
  });
});

describe('reversal date', () => {
  it('must be a real date, not before the voucher, and not before the books', async () => {
    const v = await postVoucher(db, cid, payment('2026-05-10', '100'), { source: 'MANUAL', idempotencyKey: 'rv-1', userId: user });
    const rev = (date: string) => api('POST', `/vouchers/${v.id}/reverse`, { date });
    expect((await rev('2026-02-30')).statusCode).toBe(422);
    expect((await rev('2026-05-09')).json().message).toMatch(/before the voucher/);
    const ok = await rev('2026-05-12');
    expect(ok.statusCode).toBe(200);
    expect(ok.json().date).toBe('2026-05-12');
  });
});

describe('company GSTIN moves the state with it', () => {
  it('uppercases the GSTIN and takes the state from its first two digits', async () => {
    const g = makeGstin('27', 'AAPFF1234K');
    expect((await api('PATCH', '', { gstin: g.toLowerCase() })).statusCode).toBe(200);
    expect(await one(db, `SELECT gstin, state_code FROM companies WHERE id = $1`, [cid])).toEqual({ gstin: g, state_code: '27' });
    expect((await api('PATCH', '', { gstin: 'NOT-A-GSTIN' })).statusCode).toBe(422);
    await api('PATCH', '', { gstin: makeGstin('33', 'AAPFF1234K') });
  });
});

describe('retries with the same Idempotency-Key', () => {
  let box = '';
  beforeAll(async () => {
    const b = await createBox(db, cid, { name: 'Petty Cash', floatAmount: '1000', voucherLimit: '1000', fundFromLedgerId: bank, date: '2026-06-01' }, user);
    box = b.id;
  });

  it('return the expense and top-up already posted, though the box is now empty / full', async () => {
    const e = { date: '2026-06-02', expenseLedgerId: rent, amount: '1000' };
    const first = await recordExpense(db, cid, box, e, { idempotencyKey: 'pc-1', userId: user });
    const again = await recordExpense(db, cid, box, e, { idempotencyKey: 'pc-1', userId: user });
    expect(again).toMatchObject({ id: first.id, alreadyPosted: true });
    const t = { date: '2026-06-03', fromLedgerId: bank };
    const up = await topUp(db, cid, box, t, { idempotencyKey: 'pc-2', userId: user });
    expect(await topUp(db, cid, box, t, { idempotencyKey: 'pc-2', userId: user })).toMatchObject({ id: up.id, alreadyPosted: true });
  });

  it('save a cash count once, and refuse loose coins that are not a number', async () => {
    const c = { date: '2026-06-03', notes: { 500: 2 } };
    const a = await countCash(db, cid, box, c, { idempotencyKey: 'pc-3', userId: user });
    const b = await countCash(db, cid, box, c, { idempotencyKey: 'pc-3', userId: user });
    expect(b.id).toBe(a.id);
    expect(await many(db, `SELECT 1 FROM petty_cash_counts WHERE box_id = $1`, [box])).toHaveLength(1);
    await expect(countCash(db, cid, box, { ...c, coins: 'abc' }, { idempotencyKey: 'pc-4', userId: user })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect((await api('POST', `/petty-cash/${box}/counts`, { ...c, coins: 'abc' }, { 'idempotency-key': 'pc-5' })).statusCode).toBe(422);
  });

  it('return the earlier alteration instead of ALREADY_REVERSED', async () => {
    const v = await postVoucher(db, cid, payment('2026-06-05', '300'), { source: 'MANUAL', idempotencyKey: 'al-0', userId: user });
    const opts = { source: 'MANUAL' as const, idempotencyKey: 'al-1', userId: user };
    const first = await alterVoucher(db, cid, v.id, payment('2026-06-05', '350'), opts);
    const again = await alterVoucher(db, cid, v.id, payment('2026-06-05', '350'), opts);
    expect(again.reversal).toMatchObject({ id: first.reversal.id, alreadyPosted: true });
    expect(again.posted).toMatchObject({ id: first.posted.id, alreadyPosted: true });
  });

  it('log asset upkeep once, with or without a cost posted', async () => {
    const a = await createAsset(db, cid, { name: 'Air conditioner' }, user);
    const paid = { date: '2026-06-06', kind: 'SERVICE', description: 'Gas refill', cost: '1500', paidFromLedgerId: bank };
    const x = await logUpkeep(db, cid, a.id, paid, { idempotencyKey: 'as-1', userId: user });
    const y = await logUpkeep(db, cid, a.id, paid, { idempotencyKey: 'as-1', userId: user });
    expect(y.id).toBe(x.id);
    expect(y.voucher?.id).toBe(x.voucher?.id);
    const free = { date: '2026-06-07', kind: 'INSPECTION', description: 'Checked filters' };
    expect((await logUpkeep(db, cid, a.id, free, { idempotencyKey: 'as-2', userId: user })).id)
      .toBe((await logUpkeep(db, cid, a.id, free, { idempotencyKey: 'as-2', userId: user })).id);
    expect(await many(db, `SELECT 1 FROM asset_logs WHERE asset_id = $1`, [a.id])).toHaveLength(2);
  });
});

describe('quarterly GSTR-3B estimate', () => {
  it('nets the quarter\'s PMT-06 payments even when the window leaves those months out', async () => {
    await updateComplianceSettings(db, cid, { gstFrequency: 'QUARTERLY' }, user);
    await postVoucher(db, cid, { voucherType: 'SALES', date: '2026-04-10', paymentMode: 'CASH', items: [{ amount: '10000', gstRate: '18' }] },
      { source: 'MANUAL', idempotencyKey: 'gst-1', userId: user });
    await saveRecord(db, cid, 'PMT06:2026-04:2026-04', { doneOn: '2026-05-20', amount: '1000' }, user);
    const items = await complianceItems(db, cid, '2026-07-01', '2026-07-31', '2026-07-01');
    const g3b = items.find((i) => i.kind === 'GSTR3B' && i.periodFrom === '2026-04-01')!;
    expect(g3b.estimateMinor).toBe(180_000n - 100_000n);
  });
});

describe('bad input is a 4xx, not a crash', () => {
  it('rejects impossible dates and ids that are not UUIDs', async () => {
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('2028-02-29')).toBe(true);
    expect((await api('GET', '/vouchers?from=2026-02-30&to=2026-03-01')).statusCode).toBe(422);
    expect((await api('GET', '/vouchers/not-a-uuid')).statusCode).toBe(400);
    expect((await api('GET', '/reports/ledger/123')).statusCode).toBe(400);
  });

  it('rejects an email or password that is not text', async () => {
    const signup = await app.inject({ method: 'POST', url: '/api/v1/auth/signup', payload: { name: 'X', email: 42, password: 'kanakku-2026', company: { name: 'Y', stateCode: '33' } } });
    expect(signup.statusCode).toBe(422);
    const pw = await app.inject({ method: 'POST', url: '/api/v1/auth/signup', payload: { name: 'X', email: 'x@example.com', password: 12345678, company: { name: 'Y', stateCode: '33' } } });
    expect(pw.statusCode).toBe(422);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: { a: 1 }, password: ['x'] } });
    expect(login.statusCode).toBe(401);
  });
});
