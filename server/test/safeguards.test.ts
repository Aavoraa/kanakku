import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import type { PGlite } from '@electric-sql/pglite';
import { DatabaseInUseError, dataDirOwner, many, one, openDb } from '../src/db/client';
import { dumpDatabase, listBackups, writeBackup } from '../src/db/backup';
import { createCompany, createItem, createParty } from '../src/ledger/masters';
import { alterVoucher, postVoucher, previewVoucher, reverseVoucher } from '../src/ledger/post';
import { stockAsOf } from '../src/inventory/stock';
import { closingMovingAverage } from '../src/inventory/valuation';
import { setOff, HEADS, type Head, type HeadTotals } from '../src/tax/setoff';
import { buildApp } from '../src/app';
import { makeGstin } from '../src/lib/gstin';
import { config } from '../src/config';

const user = config.localUserId;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kannaku-safe-'));
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

let db: PGlite;
let companyId: string;
let seq = 0;
const key = () => `t-${++seq}`;
const uom = async () => (await one<{ id: string }>(db, `SELECT id FROM uoms WHERE company_id = $1 AND symbol = 'Nos'`, [companyId])).id;
const item = async (name: string, valuation: 'FIFO' | 'WAVG') => (await createItem(db, companyId, { name, uomId: await uom(), valuation }, user)).id;
const buy = (itemId: string, date: string, qty: number, amount: number) => postVoucher(db, companyId, {
  voucherType: 'PURCHASE', date, paymentMode: 'CASH', items: [{ itemId, qty: String(qty), amount: String(amount), gstRate: '0' }],
}, { source: 'MANUAL', idempotencyKey: key(), userId: user });
const sell = (itemId: string, date: string, qty: number) => postVoucher(db, companyId, {
  voucherType: 'SALES', date, paymentMode: 'CASH', items: [{ itemId, qty: String(qty), amount: String(qty * 500), gstRate: '0' }],
}, { source: 'MANUAL', idempotencyKey: key(), userId: user });
const stockOf = async (itemId: string, asOf: string) => (await stockAsOf(db, companyId, asOf, itemId))[0];

beforeAll(async () => {
  db = await openDb();
  companyId = await createCompany(db, { name: 'Test Traders', stateCode: '27', gstin: makeGstin('27', 'AAAPT1234C'), booksFrom: '2026-04-01' });
}, 60_000);

describe('stock after a reversal', () => {
  for (const method of ['WAVG', 'FIFO'] as const) {
    it(`values a reversed purchase as if it never happened (${method})`, async () => {
      const id = await item(`Widget ${method}`, method);
      await buy(id, '2026-04-01', 10, 1000);              // 10 @ 100
      const wrong = await buy(id, '2026-04-02', 10, 2000); // 10 @ 200, a mistake
      await reverseVoucher(db, companyId, wrong.id, { userId: user, source: 'MANUAL', date: '2026-04-05' });
      const s = await stockOf(id, '2026-04-30');
      expect(s.qty).toBe('10');
      expect(s.valueMinor).toBe(100000n);                  // 10 x Rs 100, not Rs 1,500 / Rs 2,000
      // Before the reversal's date the mistaken purchase was still in stock.
      expect((await stockOf(id, '2026-04-03')).qty).toBe('20');
    });
  }

  it('refuses to reverse a purchase whose goods were already sold', async () => {
    const id = await item('Bracket', 'WAVG');
    const p = await buy(id, '2026-04-03', 10, 1000);
    await sell(id, '2026-04-04', 10);
    await expect(reverseVoucher(db, companyId, p.id, { userId: user, source: 'MANUAL' })).rejects.toMatchObject({ code: 'NEGATIVE_STOCK' });
  });

  it('lets Alter correct such a purchase when the new one still covers the sale', async () => {
    const id = await item('Hinge', 'WAVG');
    const p = await buy(id, '2026-04-03', 10, 1000);
    await sell(id, '2026-04-04', 10);
    const r = await alterVoucher(db, companyId, p.id, {
      voucherType: 'PURCHASE', date: '2026-04-03', paymentMode: 'CASH', items: [{ itemId: id, qty: '12', amount: '1200', gstRate: '0' }],
    }, { source: 'MANUAL', idempotencyKey: key(), userId: user });
    expect(r.posted.alreadyPosted).toBe(false);
    expect((await stockOf(id, '2026-04-30')).qty).toBe('2');
    // ...but not when it would no longer cover it.
    await expect(alterVoucher(db, companyId, r.posted.id, {
      voucherType: 'PURCHASE', date: '2026-04-03', paymentMode: 'CASH', items: [{ itemId: id, qty: '5', amount: '500', gstRate: '0' }],
    }, { source: 'MANUAL', idempotencyKey: key(), userId: user })).rejects.toMatchObject({ code: 'NEGATIVE_STOCK' });
  });

  it('refuses a backdated sale that later sales have already used the stock for', async () => {
    const id = await item('Bolt', 'FIFO');
    await buy(id, '2026-04-10', 5, 500);
    await sell(id, '2026-04-12', 5);
    // On 11 April there are 5 on hand, but selling 3 then leaves 12 April at -3.
    await expect(sell(id, '2026-04-11', 3)).rejects.toMatchObject({ code: 'NEGATIVE_STOCK' });
  });

  it('moving average settles negative stock at the incoming cost', () => {
    const c = closingMovingAverage([{ qty: new Decimal(-5), unitCost: null }, { qty: new Decimal(10), unitCost: new Decimal(20) }], true);
    expect(c.qty.toString()).toBe('5');
    expect(c.value.toString()).toBe('100');
  });
});

describe('GST set-off order', () => {
  const totals = (t: Partial<Record<Head, Partial<HeadTotals>>>) => Object.fromEntries(HEADS.map((h) => [h, {
    outputMinor: t[h]?.outputMinor ?? 0n, rcmMinor: t[h]?.rcmMinor ?? 0n, itcMinor: t[h]?.itcMinor ?? 0n,
  }])) as Record<Head, HeadTotals>;
  const by = (rows: ReturnType<typeof setOff>, h: Head) => rows.find((r) => r.component === h)!;

  it('never lets CGST credit pay SGST', () => {
    const r = setOff(totals({ CGST: { outputMinor: 10000n, itcMinor: 18000n }, SGST: { outputMinor: 10000n, itcMinor: 2000n } }));
    expect(by(r, 'CGST')).toMatchObject({ cashMinor: 0n, carryForwardMinor: 8000n });
    expect(by(r, 'SGST')).toMatchObject({ cashMinor: 8000n, carryForwardMinor: 0n });
  });

  it('uses IGST credit first, where CGST or SGST credit falls short', () => {
    const r = setOff(totals({ IGST: { itcMinor: 5000n }, CGST: { outputMinor: 5000n, itcMinor: 5000n }, SGST: { outputMinor: 5000n } }));
    expect(r.reduce((s, x) => s + x.cashMinor, 0n)).toBe(0n);
    expect(by(r, 'IGST').carryForwardMinor).toBe(0n);
  });

  it('lets CGST and SGST credit pay IGST', () => {
    const r = setOff(totals({ IGST: { outputMinor: 9000n }, CGST: { itcMinor: 4000n }, SGST: { itcMinor: 4000n } }));
    expect(by(r, 'IGST')).toMatchObject({ paidByCreditMinor: 8000n, cashMinor: 1000n });
  });

  it('keeps reverse-charge tax in cash even with credit available', () => {
    const r = setOff(totals({ CGST: { rcmMinor: 1000n, itcMinor: 1000n }, SGST: { rcmMinor: 1000n, itcMinor: 1000n } }));
    expect(by(r, 'CGST')).toMatchObject({ cashMinor: 1000n, carryForwardMinor: 1000n });
  });

  it('keeps cess apart', () => {
    const r = setOff(totals({ CESS: { outputMinor: 500n }, IGST: { itcMinor: 10000n } }));
    expect(by(r, 'CESS').cashMinor).toBe(500n);
  });
});

describe('SEZ and overseas parties', () => {
  it('charges IGST to an SEZ unit in the same state', async () => {
    const sez = await createParty(db, companyId, { name: 'Pune SEZ Unit', kind: 'CUSTOMER', stateCode: '27', regType: 'SEZ' }, user);
    const p = await previewVoucher(db, companyId, {
      voucherType: 'SALES', date: '2026-04-15', counterpartyId: sez.id, paymentMode: 'CREDIT', items: [{ amount: '1000', gstRate: '18' }],
    });
    expect(p.intraState).toBe(false);
    expect(p.taxes.map((t) => t.component)).toEqual(['IGST']);
  });
});

describe('backups and the database lock', () => {
  it('dumps a database that loads back with the same data', async () => {
    const blob = new Blob([await dumpDatabase(db)]);
    const copy = await openDb(undefined, { loadDataDir: blob });
    const names = await many<{ name: string }>(copy, `SELECT name FROM companies`);
    expect(names.map((n) => n.name)).toContain('Test Traders');
    await copy.close();
  }, 60_000);

  it('writes dated backup files and keeps only the newest', async () => {
    const dir = path.join(tmp, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    for (const n of ['20260101-000000', '20260102-000000', '20260103-000000']) fs.writeFileSync(path.join(dir, `kannaku-${n}.tar.gz`), 'old');
    const file = await writeBackup(db, dir, 2);
    expect(listBackups(dir)).toHaveLength(2);
    expect(listBackups(dir).at(-1)).toBe(path.basename(file));
    expect(fs.statSync(file).size).toBeGreaterThan(1000);
  });

  it('will not open a data directory another process holds, and frees it on close', async () => {
    const dir = path.join(tmp, 'pg');
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    // A live process that is not us: the parent of this test runner.
    fs.writeFileSync(`${dir}.lock`, String(process.ppid));
    expect(dataDirOwner(dir)).toBe(process.ppid);
    await expect(openDb(dir)).rejects.toBeInstanceOf(DatabaseInUseError);
    // A lock left by a process that has gone is taken over.
    fs.writeFileSync(`${dir}.lock`, '999999');
    const d = await openDb(dir);
    expect(fs.readFileSync(`${dir}.lock`, 'utf8')).toBe(String(process.pid));
    await d.close();
    expect(fs.existsSync(`${dir}.lock`)).toBe(false);
  }, 60_000);

  it('restores a backup into an empty data directory (what restore-backup does)', async () => {
    const dir = path.join(tmp, 'restored');
    const restored = await openDb(dir, { loadDataDir: new Blob([await dumpDatabase(db)]) });
    expect((await many<{ name: string }>(restored, `SELECT name FROM companies`)).map((n) => n.name)).toContain('Test Traders');
    await restored.close();
    // And it opens again normally afterwards.
    const again = await openDb(dir);
    expect((await one<{ n: bigint }>(again, `SELECT COUNT(*)::bigint AS n FROM companies`)).n).toBeGreaterThan(0n);
    await again.close();
  }, 60_000);
});

describe('installation-wide settings and cross-site requests', () => {
  it('lets only the first account manage the AI key and backups, even when others own their companies', async () => {
    const appDb = await openDb();
    const app = await buildApp(appDb);
    const signup = async (email: string, gst: string) => String((await app.inject({ method: 'POST', url: '/api/v1/auth/signup', payload: {
      name: 'User', email, password: 'kanakku-2026', company: { name: `Books of ${email}`, gstin: makeGstin('33', gst), booksFrom: '2026-04-01' },
    } })).headers['set-cookie']).split(';')[0];
    const admin = await signup('first@example.com', 'AAPFM5678K');
    const other = await signup('other@example.com', 'AAPFN5678K');
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/settings/ai-key', headers: { cookie: other } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/v1/backups', headers: { cookie: other } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: admin } })).json().isAdmin).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: other } })).json().isAdmin).toBe(false);

    // A page on another site (or another localhost port) cannot make changes with the user's cookie.
    const cross = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie: admin, 'sec-fetch-site': 'same-site' } });
    expect(cross.statusCode).toBe(403);
    const own = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie: admin, 'sec-fetch-site': 'same-origin' } });
    expect(own.statusCode).toBe(200);
    await app.close();
    await appDb.close();
  }, 60_000);
});
