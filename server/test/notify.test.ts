import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { many, openDb } from '../src/db/client';
import { createCompany } from '../src/ledger/masters';
import { createTask } from '../src/compliance/service';
import { emailText, loadConfig, publicConfig, runDueDigests, saveConfig, sendDigest, senders, smsText, TEMPLATES, whatsappParams } from '../src/notify/service';
import { makeGstin } from '../src/lib/gstin';
import { todayIST, addDays } from '../src/lib/dates';
import { config } from '../src/config';

const user = config.localUserId;
let db: PGlite;
let companyId: string;
const sent: { channel: string; to: string; body: unknown }[] = [];
const real = { ...senders };

beforeAll(async () => {
  db = await openDb();
  companyId = await createCompany(db, { name: 'Reminder Traders', stateCode: '33', gstin: makeGstin('33', 'AAAFR1234K'), booksFrom: '2026-04-01' });
  // Something due in two days, so the digest has content.
  await createTask(db, companyId, { title: 'Bank reconciliation', category: 'WORKING', firstDue: addDays(todayIST(), 2), repeat: 'NONE', remindDays: 3 }, user);
  senders.email = async (_c, to, subject, text) => { sent.push({ channel: 'EMAIL', to, body: { subject, text } }); };
  senders.whatsapp = async (_c, to, params) => { sent.push({ channel: 'WHATSAPP', to, body: params }); };
  senders.sms = async (c, to, message) => { sent.push({ channel: 'SMS', to, body: c.sendUrl.replace('{to}', to).replace('{message}', encodeURIComponent(message)) }); };
}, 60_000);
afterAll(() => { Object.assign(senders, real); });

describe('reminder settings', () => {
  it('validates each channel, and never hands secrets back', async () => {
    await expect(saveConfig(db, companyId, { email: { on: true, to: 'not-an-email' } }, user)).rejects.toThrow(/not an email/);
    await expect(saveConfig(db, companyId, { email: { on: true, to: 'a@b.in' } }, user)).rejects.toThrow(/mail server/);
    await expect(saveConfig(db, companyId, { sms: { sendUrl: 'http://10.0.0.5/send?to={to}&msg={message}' } }, user)).rejects.toThrow(/https/);
    await expect(saveConfig(db, companyId, { sms: { sendUrl: 'https://localhost/send?to={to}&msg={message}' } }, user)).rejects.toThrow(/internet address/);
    await expect(saveConfig(db, companyId, { whatsapp: { to: '12345' } }, user)).rejects.toThrow(/not a mobile number/);
    const saved = await saveConfig(db, companyId, {
      enabled: true, sendAt: '09:00',
      email: { on: true, to: 'owner@example.com, ca@example.com', host: 'smtp.gmail.com', port: 587, user: 'owner@example.com', pass: 'app-pass-1234' },
      whatsapp: { on: true, to: '98400 12345', token: 'EAAG-secret', phoneNumberId: '1234567890' },
      sms: { on: true, to: '+91 98400 55555', sendUrl: 'https://sms.example.in/api/send?key=K&to={to}&text={message}&dlt=1107' },
    }, user);
    expect(saved.email).toMatchObject({ to: ['owner@example.com', 'ca@example.com'], hasPass: true });
    expect(saved.whatsapp).toMatchObject({ to: ['919840012345'], hasToken: true });
    expect(saved.sms).toMatchObject({ to: ['919840055555'], hasSendUrl: true, sendUrlHost: 'sms.example.in' });
    expect(JSON.stringify(saved)).not.toMatch(/app-pass-1234|EAAG-secret|key=K/);
    // A blank secret keeps the saved one.
    await saveConfig(db, companyId, { email: { pass: '' }, whatsapp: { token: '' } }, user);
    const c = await loadConfig(db, companyId);
    expect([c.email.pass, c.whatsapp.token]).toEqual(['app-pass-1234', 'EAAG-secret']);
    expect(JSON.stringify(publicConfig(c))).not.toContain('app-pass-1234');
    // And the audit log never holds them either.
    const log = await many<{ after: unknown }>(db, `SELECT after FROM audit_log WHERE entity = 'notification_settings'`);
    expect(JSON.stringify(log)).not.toMatch(/app-pass-1234|EAAG-secret/);
  });
});

describe('digests', () => {
  it('builds texts that fit each channel', () => {
    const d = { company: 'Reminder Traders', overdue: 1, dueSoon: 1, includeAmounts: false, items: [
      { title: 'GSTR-3B return and GST payment', periodLabel: 'Sep 2026', due: '2026-10-20', daysLeft: 3, status: 'DUE_SOON', estimateMinor: 180000n },
      { title: 'GSTR-1 (outward supplies)', periodLabel: 'Sep 2026', due: '2026-10-11', daysLeft: -6, status: 'OVERDUE', estimateMinor: null },
    ] } as unknown as Parameters<typeof emailText>[0];
    expect(emailText(d).subject).toBe('Kannaku AI · Reminder Traders: 1 overdue, 1 due soon');
    expect(emailText(d).text).toContain('GSTR-1 (outward supplies) (Sep 2026): overdue by 6 days, 11 Oct 2026');
    expect(emailText(d).text).not.toContain('₹');                       // amounts only when switched on
    expect(emailText({ ...d, includeAmounts: true }).text).toContain('₹1,800.00');
    const p = whatsappParams(d);
    expect(p).toHaveLength(3);
    expect(p.join('')).not.toMatch(/\n/);
    // The SMS follows the registered DLT template exactly, with the variables filled in.
    const sms = smsText(d);
    const pattern = new RegExp(`^${TEMPLATES.sms.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{#var#\\\}/g, '.+')}$`);
    expect(sms).toMatch(pattern);
  });

  it('a test sends to every recipient of that channel and logs it', async () => {
    sent.length = 0;
    const r = await sendDigest(db, companyId, { test: true, only: 'EMAIL' });
    expect(r.results.map((x) => x.to)).toEqual(['owner@example.com', 'ca@example.com']);
    expect((sent[0].body as { subject: string }).subject).toMatch(/^\[Test\] Kannaku AI · Reminder Traders/);
    expect((sent[0].body as { text: string }).text).toContain('Bank reconciliation');
  });

  it('a failing channel is logged as failed and does not stop the others', async () => {
    sent.length = 0;
    const ok = senders.whatsapp;
    senders.whatsapp = async () => { throw new Error('WhatsApp said 401: token expired'); };
    const r = await sendDigest(db, companyId, { test: true });
    senders.whatsapp = ok;
    expect(r.results.find((x) => x.channel === 'WHATSAPP')).toMatchObject({ ok: false, error: expect.stringMatching(/401/) });
    expect(sent.filter((s) => s.channel === 'SMS')).toHaveLength(1);
    expect(String(sent.find((s) => s.channel === 'SMS')!.body)).toMatch(/^https:\/\/sms\.example\.in\/api\/send\?key=K&to=919840055555&text=Kannaku%20AI/);
  });

  it('the daily run sends once after the send time, not before and not twice', async () => {
    sent.length = 0;
    const at = (hhmm: string) => new Date(`${todayIST()}T${hhmm}:00+05:30`);
    await runDueDigests(db, at('08:30'));
    expect(sent).toHaveLength(0);
    await runDueDigests(db, at('09:05'));
    expect(sent.map((s) => s.channel).sort()).toEqual(['EMAIL', 'EMAIL', 'SMS', 'WHATSAPP']);
    await runDueDigests(db, at('09:10'));
    expect(sent).toHaveLength(4);
  });
});
