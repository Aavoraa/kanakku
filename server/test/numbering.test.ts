import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PGlite } from '@electric-sql/pglite';
import { openDb } from '../src/db/client';
import { buildApp } from '../src/app';
import { correctionNote, formatVoucherNo, postVoucher, reverseVoucher } from '../src/ledger/post';
import { createLedger, groupByCode } from '../src/ledger/masters';
import { makeGstin } from '../src/lib/gstin';
import { todayIST } from '../src/lib/dates';
import { config } from '../src/config';

const user = config.localUserId;

describe('voucher numbers by financial year', () => {
  const f = (no: bigint, base: 'SALES' | 'PURCHASE' | 'JOURNAL', date: string, from: string | null) =>
    formatVoucherNo(no, { prefix: '', base, date, fyNumberingFrom: from, fyStartMonth: 4 });

  it('keeps plain numbers before the switch date, and SI/27-28/0001 from it', () => {
    expect(f(41n, 'SALES', '2027-03-31', '2027-04-01')).toBe('41');
    expect(f(1n, 'SALES', '2027-04-01', '2027-04-01')).toBe('SI/27-28/0001');
    expect(f(12n, 'PURCHASE', '2028-01-15', '2027-04-01')).toBe('PI/27-28/0012');   // January belongs to the year that began in April
    expect(f(10234n, 'JOURNAL', '2027-06-01', '2027-04-01')).toBe('JV/27-28/10234');
    expect(f(5n, 'SALES', '2027-06-01', null)).toBe('5');
    expect(f(1n, 'SALES', '2099-04-01', '2027-04-01').length).toBeLessThanOrEqual(16);  // GST rule 46: up to 16 characters
  });
});

describe('numbering setting and closed-period corrections (API)', () => {
  let db: PGlite;
  let app: FastifyInstance;
  let cookie = '';
  let cid = '';
  const api = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object, headers: Record<string, string> = {}) =>
    app.inject({ method, url: `/api/v1/companies/${cid}${url}`, payload, headers: { cookie, ...headers } });

  beforeAll(async () => {
    db = await openDb();
    app = await buildApp(db);
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/signup', payload: {
      name: 'Owner', email: 'num@example.com', password: 'kanakku-2026', company: { name: 'Number Co', gstin: makeGstin('33', 'AAPFN1234K'), booksFrom: '2026-04-01' },
    } });
    cookie = String(res.headers['set-cookie']).split(';')[0];
    cid = res.json().companyId;
  }, 60_000);

  it('a new company numbers by financial year from its first year', async () => {
    const r = await api('POST', '/vouchers', { voucherType: 'SALES', date: '2026-04-10', paymentMode: 'CASH', items: [{ amount: '1000', gstRate: '18' }] }, { 'idempotency-key': 'n1' });
    expect(r.json().voucherNo).toBe('SI/26-27/0001');
  });

  it('lets the switch date move only to the start of a year without vouchers', async () => {
    expect((await api('PATCH', '', { fyNumberingFrom: '2026-05-01' })).statusCode).toBe(422);      // not a year start
    expect((await api('PATCH', '', { fyNumberingFrom: '2026-04-01' })).json().message).toMatch(/already posted/);
    expect((await api('PATCH', '', { fyNumberingFrom: '2027-04-01' })).statusCode).toBe(200);
    // Now this year falls before the switch: back to plain numbers (the series carries on from 1).
    const r = await api('POST', '/vouchers', { voucherType: 'SALES', date: '2026-04-11', paymentMode: 'CASH', items: [{ amount: '500', gstRate: '0' }] }, { 'idempotency-key': 'n2' });
    expect(r.json().voucherNo).toBe('2');
  });

  it('a sale in a closed period is corrected with a credit note dated today, not reversed', async () => {
    const sale = await postVoucher(db, cid, { voucherType: 'SALES', date: '2026-04-12', paymentMode: 'CASH', items: [{ amount: '2000', gstRate: '18' }] },
      { source: 'MANUAL', idempotencyKey: 'n3', userId: user });
    expect((await api('PATCH', '', { lockDate: '2026-04-30' })).statusCode).toBe(200);
    const rev = await api('POST', `/vouchers/${sale.id}/reverse`, {});
    expect(rev.statusCode).toBe(409);
    expect(rev.json()).toMatchObject({ code: 'USE_NOTE', details: { noteType: 'CREDIT_NOTE' } });
    const note = (await api('GET', `/vouchers/${sale.id}/correction-note`)).json();
    expect(note).toMatchObject({ voucherType: 'CREDIT_NOTE', date: todayIST(), originalRef: sale.voucherNo, items: [{ amount: '2000', gstRate: '18' }] });
    const posted = await api('POST', '/vouchers', note, { 'idempotency-key': 'n4' });
    expect(posted.statusCode).toBe(200);
    expect(posted.json().voucherType).toBe('CREDIT_NOTE');
  });

  it('payments in a closed period are still reversed, dated today', async () => {
    const bank = (await createLedger(db, cid, { name: 'Axis Bank', groupId: (await groupByCode(db, cid, 'BANK_ACCOUNTS')).id, openingBalance: '10000' }, user)).id;
    const rent = (await createLedger(db, cid, { name: 'Rent', groupId: (await groupByCode(db, cid, 'INDIRECT_EXPENSES')).id }, user)).id;
    // Post into April by lifting the lock for a moment, then lock again.
    await api('PATCH', '', { lockDate: null });
    const pay = await postVoucher(db, cid, { voucherType: 'PAYMENT', date: '2026-04-20', entries: [{ ledgerId: rent, side: 'DR', amount: '100' }, { ledgerId: bank, side: 'CR', amount: '100' }] },
      { source: 'MANUAL', idempotencyKey: 'n5', userId: user });
    await api('PATCH', '', { lockDate: '2026-04-30' });
    const r = await reverseVoucher(db, cid, pay.id, { userId: user, source: 'MANUAL' });
    expect(r.date).toBe(todayIST());
    await expect(correctionNote(db, cid, pay.id)).rejects.toMatchObject({ code: 'NO_NOTE' });
  });
});
