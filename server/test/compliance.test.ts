import { beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { openDb } from '../src/db/client';
import { createCompany } from '../src/ledger/masters';
import { postVoucher } from '../src/ledger/post';
import { DEFAULT_SETTINGS, addMonthsKeepDay, statutoryDues, taskDues, type ComplianceSettings } from '../src/compliance/calendar';
import { complianceAlerts, complianceItems, createTask, saveRecord, updateComplianceSettings } from '../src/compliance/service';
import { makeGstin } from '../src/lib/gstin';
import { config } from '../src/config';
import { buildApp } from '../src/app';

const facts = (stateCode: string) => ({ stateCode, hasGstin: true, booksFrom: '2025-04-01' });
const s = (patch: Partial<ComplianceSettings>): ComplianceSettings => ({ ...DEFAULT_SETTINGS, ...patch });
const due = (list: ReturnType<typeof statutoryDues>, kind: string, periodFrom: string) => list.find((d) => d.kind === kind && d.periodFrom === periodFrom)?.dueDate;

describe('statutory due dates', () => {
  it('monthly GST: GSTR-1 on the 11th and GSTR-3B on the 20th of the next month', () => {
    const l = statutoryDues(s({}), facts('33'), '2026-10-01', '2026-10-31');
    expect(due(l, 'GSTR1', '2026-09-01')).toBe('2026-10-11');
    expect(due(l, 'GSTR3B', '2026-09-01')).toBe('2026-10-20');
  });

  it('QRMP: PMT-06 on the 25th; quarterly GSTR-1 on the 13th; GSTR-3B on the 22nd or 24th by state', () => {
    const q = s({ gstFrequency: 'QUARTERLY' });
    const tn = statutoryDues(q, facts('33'), '2026-08-01', '2026-10-31');   // Tamil Nadu: 22nd
    expect(due(tn, 'PMT06', '2026-07-01')).toBe('2026-08-25');
    expect(due(tn, 'PMT06', '2026-08-01')).toBe('2026-09-25');
    expect(due(tn, 'GSTR1', '2026-07-01')).toBe('2026-10-13');
    expect(due(tn, 'GSTR3B', '2026-07-01')).toBe('2026-10-22');
    expect(tn.some((d) => d.kind === 'GSTR3B' && d.periodFrom === '2026-09-01')).toBe(false);
    const delhi = statutoryDues(q, facts('07'), '2026-10-01', '2026-10-31');
    expect(due(delhi, 'GSTR3B', '2026-07-01')).toBe('2026-10-24');
  });

  it('no GST reminders without a GSTIN', () => {
    expect(statutoryDues(s({}), { ...facts('33'), hasGstin: false }, '2026-01-01', '2026-12-31').some((d) => d.category === 'GST')).toBe(false);
  });

  it('TDS: the 7th, except March on 30 April; returns 31 Jul / 31 Oct / 31 Jan / 31 May', () => {
    const l = statutoryDues(s({ tds: true }), facts('27'), '2026-01-01', '2026-12-31');
    expect(due(l, 'TDS_PAY', '2026-02-01')).toBe('2026-03-07');
    expect(due(l, 'TDS_PAY', '2026-03-01')).toBe('2026-04-30');
    expect(due(l, 'TDS_RETURN', '2026-01-01')).toBe('2026-05-31');
    expect(due(l, 'TDS_RETURN', '2026-04-01')).toBe('2026-07-31');
    expect(due(l, 'TDS_RETURN', '2026-07-01')).toBe('2026-10-31');
    expect(statutoryDues(s({ tds: true }), facts('27'), '2027-01-01', '2027-01-31').find((d) => d.kind === 'TDS_RETURN')?.dueDate).toBe('2027-01-31');
  });

  it('income tax: advance tax on the 15th of Jun/Sep/Dec/Mar; ITR 31 July, or 31 October with a tax audit (report by 30 Sep)', () => {
    const plain = statutoryDues(s({}), facts('27'), '2026-04-01', '2027-03-31');
    expect(plain.filter((d) => d.kind === 'ADV_TAX').map((d) => d.dueDate)).toEqual(['2026-06-15', '2026-09-15', '2026-12-15', '2027-03-15']);
    expect(plain.find((d) => d.kind === 'ITR')).toMatchObject({ dueDate: '2026-07-31', periodLabel: 'FY 2025-26' });
    const audited = statutoryDues(s({ taxAudit: true }), facts('27'), '2026-04-01', '2027-03-31');
    expect(audited.find((d) => d.kind === 'ITR')?.dueDate).toBe('2026-10-31');
    expect(audited.find((d) => d.kind === 'TAX_AUDIT')?.dueDate).toBe('2026-09-30');
  });

  it('GSTR-9 on 31 December when switched on', () => {
    expect(statutoryDues(s({ gstAnnual: true }), facts('27'), '2026-12-01', '2026-12-31').find((d) => d.kind === 'GSTR9'))
      .toMatchObject({ dueDate: '2026-12-31', periodLabel: 'FY 2025-26' });
  });

  it('skips periods before the books begin', () => {
    const l = statutoryDues(s({}), { ...facts('27'), booksFrom: '2026-09-01' }, '2026-09-01', '2026-10-31');
    expect(l.some((d) => d.periodFrom === '2026-08-01')).toBe(false);
    expect(l.some((d) => d.periodFrom === '2026-09-01')).toBe(true);
  });
});

describe('own reminders', () => {
  it('repeat monthly keeping the day, clamped at month end', () => {
    expect(addMonthsKeepDay('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonthsKeepDay('2026-01-31', 2)).toBe('2026-03-31');
    const t = taskDues([{ id: 'x', title: 'Depreciation working', category: 'CALCULATION', first_due: '2026-01-31', repeat: 'MONTHLY', remind_days: 3, notes: null }], '2026-02-01', '2026-04-30');
    expect(t.map((d) => d.dueDate)).toEqual(['2026-02-28', '2026-03-31', '2026-04-30']);
  });
});

describe('compliance API', () => {
  it('saves a filing record through the API, with the colons in its key encoded in the URL', async () => {
    const appDb = await openDb();
    const app = await buildApp(appDb);
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/signup', payload: {
      name: 'Owner', email: 'cal@example.com', password: 'kanakku-2026', company: { name: 'API Co', gstin: makeGstin('33', 'AAPFC5678K'), booksFrom: '2026-04-01' },
    } });
    const cookie = String(res.headers['set-cookie']).split(';')[0];
    const cid = res.json().companyId as string;
    const view = (await app.inject({ method: 'GET', url: `/api/v1/companies/${cid}/compliance?from=2026-10-01&to=2026-10-31`, headers: { cookie } })).json();
    const key = view.items.find((i: { kind: string }) => i.kind === 'GSTR1').key as string;
    const put = await app.inject({ method: 'PUT', url: `/api/v1/companies/${cid}/compliance/records/${encodeURIComponent(key)}`, headers: { cookie },
      payload: { doneOn: '2026-10-10', reference: 'AA330926000123', amount: null } });
    expect(put.statusCode).toBe(200);
    const alerts = (await app.inject({ method: 'GET', url: `/api/v1/companies/${cid}/compliance/alerts`, headers: { cookie } })).json();
    expect(alerts.items.some((i: { key: string }) => i.key === key)).toBe(false);
    // Another account cannot read or change this company's calendar.
    const other = await app.inject({ method: 'POST', url: '/api/v1/auth/signup', payload: {
      name: 'Other', email: 'other-cal@example.com', password: 'kanakku-2026', company: { name: 'Other Co', stateCode: '27', booksFrom: '2026-04-01' },
    } });
    const otherCookie = String(other.headers['set-cookie']).split(';')[0];
    expect((await app.inject({ method: 'GET', url: `/api/v1/companies/${cid}/compliance/alerts`, headers: { cookie: otherCookie } })).statusCode).toBe(404);
    await app.close();
    await appDb.close();
  }, 60_000);
});

describe('records and alerts', () => {
  let db: PGlite;
  let companyId: string;
  const user = config.localUserId;
  const today = '2026-10-17';

  beforeAll(async () => {
    db = await openDb();
    companyId = await createCompany(db, { name: 'Calendar Co', stateCode: '33', gstin: makeGstin('33', 'AAACC1234D'), booksFrom: '2026-04-01' });
  }, 60_000);

  it('shows the GST payable from the books against GSTR-3B', async () => {
    await postVoucher(db, companyId, { voucherType: 'SALES', date: '2026-09-10', paymentMode: 'CASH', items: [{ amount: '10000', gstRate: '18' }] },
      { source: 'MANUAL', idempotencyKey: 'cal-sale', userId: user });
    const items = await complianceItems(db, companyId, '2026-10-01', '2026-10-31', today);
    const b = items.find((i) => i.key === 'GSTR3B:2026-09:2026-09')!;
    expect(b.status).toBe('DUE_SOON');               // due 20 Oct; reminders start 5 days before, on 15 Oct
    expect(b.daysLeft).toBe(3);
    expect(b.estimateMinor).toBe(180000n);           // 9% + 9% of Rs 10,000
  });

  it('lists overdue and due-soon items, and drops them once filed', async () => {
    const a = await complianceAlerts(db, companyId, today);
    // GSTR-1 for September was due on 11 Oct: overdue on 17 Oct. GSTR-3B (20 Oct) is within the 5-day window.
    expect(a.items.find((i) => i.key === 'GSTR1:2026-09:2026-09')?.status).toBe('OVERDUE');
    expect(a.items.find((i) => i.key === 'GSTR3B:2026-09:2026-09')?.status).toBe('DUE_SOON');
    await saveRecord(db, companyId, 'GSTR1:2026-09:2026-09', { doneOn: '2026-10-12', reference: 'AA3309260000001' }, user);
    const after = await complianceAlerts(db, companyId, today);
    expect(after.items.some((i) => i.key === 'GSTR1:2026-09:2026-09')).toBe(false);
    const rec = (await complianceItems(db, companyId, '2026-10-01', '2026-10-31', today)).find((i) => i.key === 'GSTR1:2026-09:2026-09')!;
    expect(rec).toMatchObject({ status: 'DONE', record: { doneOn: '2026-10-12', reference: 'AA3309260000001' } });
  });

  it('an extended due date moves the item, and undoing a filing brings it back', async () => {
    await saveRecord(db, companyId, 'GSTR3B:2026-09:2026-09', { dueDate: '2026-10-31' }, user);
    let b = (await complianceItems(db, companyId, '2026-10-01', '2026-10-31', today)).find((i) => i.kind === 'GSTR3B')!;
    expect(b).toMatchObject({ due: '2026-10-31', extended: true, status: 'UPCOMING' });
    await saveRecord(db, companyId, 'GSTR1:2026-09:2026-09', { doneOn: null, reference: null }, user);
    b = (await complianceItems(db, companyId, '2026-10-01', '2026-10-31', today)).find((i) => i.key === 'GSTR1:2026-09:2026-09')!;
    expect(b.status).toBe('OVERDUE');
  });

  it('refuses unknown keys, bad dates and future filing dates', async () => {
    await expect(saveRecord(db, companyId, 'HACK:1', { doneOn: '2026-10-01' }, user)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(saveRecord(db, companyId, 'GSTR1:2026-09:2026-09', { doneOn: '17/10/2026' }, user)).rejects.toThrow(/date/);
    await expect(saveRecord(db, companyId, 'GSTR1:2026-09:2026-09', { doneOn: '2999-01-01' }, user)).rejects.toThrow(/future/);
  });

  it('own reminders show up, and settings switch obligations on and off', async () => {
    await createTask(db, companyId, { title: 'Bank reconciliation working', category: 'WORKING', firstDue: '2026-10-18', repeat: 'MONTHLY', remindDays: 2 }, user);
    expect((await complianceAlerts(db, companyId, today)).items.some((i) => i.title === 'Bank reconciliation working')).toBe(true);
    await updateComplianceSettings(db, companyId, { gstFrequency: 'QUARTERLY', tds: true }, user);
    const items = await complianceItems(db, companyId, '2026-10-01', '2026-10-31', today);
    expect(items.some((i) => i.kind === 'GSTR3B' && i.periodFrom === '2026-07-01')).toBe(true);
    expect(items.some((i) => i.kind === 'TDS_PAY')).toBe(true);
  });
});
