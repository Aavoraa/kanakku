import nodemailer from 'nodemailer';
import type { PGlite } from '@electric-sql/pglite';
import { many, maybeOne, one, type Db } from '../db/client';
import { AppError, invalid } from '../lib/errors';
import { formatINR } from '../lib/money';
import { shortDate, todayIST } from '../lib/dates';
import { audit } from '../ledger/post';
import { complianceAlerts, type Item } from '../compliance/service';

/**
 * Daily reminder digests by email, WhatsApp and SMS: what is overdue or due soon (the same list as the bell).
 *
 * Each channel goes through the company's own account with a provider: their mailbox (SMTP), Meta's WhatsApp
 * Business Cloud API, an Indian SMS gateway registered on DLT. Passwords and tokens are stored in the database and
 * never sent back to the browser. Digests carry the company name, what is due and when; amounts only if asked for.
 */

export type Channel = 'EMAIL' | 'WHATSAPP' | 'SMS';

export interface NotifyConfig {
  enabled: boolean;
  /** Time of day (IST) the daily digest goes out, "HH:MM". */
  sendAt: string;
  includeAmounts: boolean;
  email: { on: boolean; to: string[]; host: string; port: number; secure: boolean; user: string; pass: string; from: string };
  whatsapp: { on: boolean; to: string[]; token: string; phoneNumberId: string; template: string; language: string; apiVersion: string };
  /** sendUrl: the provider's send link with {to} and {message} where the number and text go (DLT IDs included). */
  sms: { on: boolean; to: string[]; sendUrl: string };
}

const DEFAULTS: NotifyConfig = {
  enabled: false, sendAt: '09:00', includeAmounts: false,
  email: { on: false, to: [], host: '', port: 587, secure: false, user: '', pass: '', from: '' },
  whatsapp: { on: false, to: [], token: '', phoneNumberId: '', template: 'kannaku_due_reminder', language: 'en', apiVersion: 'v24.0' },
  sms: { on: false, to: [], sendUrl: '' },
};

/** Texts to register with the providers, so the digest matches an approved template word for word. */
export const TEMPLATES = {
  whatsapp: 'Kannaku AI reminder for {{1}}: {{2}}. Due: {{3}}. Open Kannaku AI for details.',
  sms: 'Kannaku AI: {#var#}: {#var#} overdue, {#var#} due soon. Next: {#var#} on {#var#}.',
};

function merge(raw: unknown): NotifyConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<NotifyConfig>;
  return {
    ...DEFAULTS, ...r,
    email: { ...DEFAULTS.email, ...(r.email ?? {}) },
    whatsapp: { ...DEFAULTS.whatsapp, ...(r.whatsapp ?? {}) },
    sms: { ...DEFAULTS.sms, ...(r.sms ?? {}) },
  };
}

export async function loadConfig(db: Db, companyId: string): Promise<NotifyConfig> {
  const row = await maybeOne<{ config: unknown }>(db, `SELECT config FROM notification_settings WHERE company_id = $1`, [companyId]);
  return merge(row?.config);
}

/** The settings as the browser sees them: secrets replaced by whether they are set. */
export function publicConfig(c: NotifyConfig) {
  let smsHost: string | null = null;
  try { smsHost = c.sms.sendUrl ? new URL(c.sms.sendUrl.replace(/\{(to|message)\}/g, 'x')).host : null; } catch { smsHost = null; }
  return {
    enabled: c.enabled, sendAt: c.sendAt, includeAmounts: c.includeAmounts,
    email: { ...c.email, pass: undefined, hasPass: Boolean(c.email.pass) },
    whatsapp: { ...c.whatsapp, token: undefined, hasToken: Boolean(c.whatsapp.token) },
    sms: { on: c.sms.on, to: c.sms.to, hasSendUrl: Boolean(c.sms.sendUrl), sendUrlHost: smsHost },
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Mobile numbers with country code, digits only (91XXXXXXXXXX), as WhatsApp and SMS gateways expect. */
const phone = (s: string) => {
  const d = s.replace(/[\s()+-]/g, '');
  if (/^\d{10}$/.test(d)) return `91${d}`;                  // an Indian 10-digit number
  if (!/^\d{11,15}$/.test(d)) throw invalid(`${s} is not a mobile number (include the country code, e.g. 91 98400 12345)`);
  return d;
};
const list = (v: unknown) => (Array.isArray(v) ? v : String(v ?? '').split(/[,;\n]/)).map((x) => String(x).trim()).filter(Boolean);

/** Rejects addresses that would make the server call itself or the local network (the SMS link is fetched by the server). */
function assertPublicHttps(url: string) {
  let u: URL;
  try { u = new URL(url.replace(/\{(to|message)\}/g, 'x')); } catch { throw invalid('The SMS link is not a valid web address'); }
  if (u.protocol !== 'https:') throw invalid('The SMS link must start with https://');
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[)/i.test(u.hostname)) throw invalid('The SMS link must be your provider’s internet address');
  if (!url.includes('{to}') || !url.includes('{message}')) throw invalid('Put {to} and {message} in the SMS link where the number and the text go');
}

/** Saves settings. A blank password, token or SMS link keeps the one already saved. */
export async function saveConfig(db: PGlite, companyId: string, patch: Record<string, any>, userId: string) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const cur = await loadConfig(db, companyId);
  const p = patch ?? {};
  const next = merge({
    ...cur,
    enabled: p.enabled ?? cur.enabled,
    sendAt: p.sendAt ?? cur.sendAt,
    includeAmounts: p.includeAmounts ?? cur.includeAmounts,
    email: { ...cur.email, ...(p.email ?? {}), pass: p.email?.pass ? String(p.email.pass) : p.email?.clearPass ? '' : cur.email.pass },
    whatsapp: { ...cur.whatsapp, ...(p.whatsapp ?? {}), token: p.whatsapp?.token ? String(p.whatsapp.token).trim() : p.whatsapp?.clearToken ? '' : cur.whatsapp.token },
    sms: { ...cur.sms, ...(p.sms ?? {}), sendUrl: p.sms?.sendUrl ? String(p.sms.sendUrl).trim() : p.sms?.clearSendUrl ? '' : cur.sms.sendUrl },
  });
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(next.sendAt)) throw invalid('Send time must look like 09:00');
  next.email.to = list(next.email.to);
  for (const a of next.email.to) if (!EMAIL_RE.test(a)) throw invalid(`${a} is not an email address`);
  next.email.port = Number(next.email.port) || 587;
  next.email.secure = Boolean(next.email.secure);
  if (next.email.on) {
    if (!next.email.to.length) throw invalid('Add at least one email address to send to');
    if (!next.email.host || !next.email.user || !next.email.pass) throw invalid('Enter the mail server, user name and password (for Gmail: smtp.gmail.com and an app password)');
    if (!EMAIL_RE.test(next.email.from || next.email.user)) throw invalid('The "from" address is not an email address');
  }
  next.whatsapp.to = list(next.whatsapp.to).map(phone);
  if (next.whatsapp.on) {
    if (!next.whatsapp.to.length) throw invalid('Add at least one WhatsApp number to send to');
    if (!next.whatsapp.token || !/^\d{5,20}$/.test(next.whatsapp.phoneNumberId)) throw invalid('Enter the WhatsApp access token and phone number ID from Meta (WhatsApp Manager → API setup)');
    if (!/^[a-z0-9_]{1,512}$/.test(next.whatsapp.template)) throw invalid('Template name: lower-case letters, digits and _ as approved in WhatsApp Manager');
    if (!/^v\d{1,2}\.\d$/.test(next.whatsapp.apiVersion)) throw invalid('API version looks like v24.0');
  }
  next.sms.to = list(next.sms.to).map(phone);
  if (next.sms.on) {
    if (!next.sms.to.length) throw invalid('Add at least one mobile number for SMS');
    if (!next.sms.sendUrl) throw invalid('Paste your SMS provider’s send link');
  }
  if (next.sms.sendUrl) assertPublicHttps(next.sms.sendUrl);
  await db.query(
    `INSERT INTO notification_settings (company_id, config, updated_by, updated_at) VALUES ($1,$2,$3,now())
     ON CONFLICT (company_id) DO UPDATE SET config = $2, updated_by = $3, updated_at = now()`, [companyId, JSON.stringify(next), userId]);
  // The audit log records what changed, never the secrets themselves.
  const safe = (c: NotifyConfig) => JSON.parse(JSON.stringify(publicConfig(c)));
  await audit(db, companyId, userId, 'MANUAL', 'UPDATE', 'notification_settings', companyId, safe(cur), safe(next));
  return publicConfig(next);
}

// ---------- The digest ----------

export interface Digest { company: string; overdue: number; dueSoon: number; items: Item[]; includeAmounts: boolean }

const when = (i: Item) => (i.status === 'OVERDUE' ? `overdue by ${-i.daysLeft} day${i.daysLeft === -1 ? '' : 's'}` : i.daysLeft === 0 ? 'due today' : `due in ${i.daysLeft} day${i.daysLeft === 1 ? '' : 's'}`);
const amount = (d: Digest, i: Item) => (d.includeAmounts && i.estimateMinor && i.estimateMinor > 0n ? ` (₹${formatINR(i.estimateMinor)})` : '');
/** Template variables cannot hold line breaks or long runs of spaces (WhatsApp), and SMS variables are short. */
const flat = (s: string, max: number) => s.replace(/\s+/g, ' ').trim().slice(0, max);

export function emailText(d: Digest) {
  const subject = d.items.length
    ? `Kannaku AI · ${d.company}: ${d.overdue ? `${d.overdue} overdue, ` : ''}${d.dueSoon} due soon`
    : `Kannaku AI · ${d.company}: nothing due`;
  const lines = d.items.map((i) => `• ${i.title} (${i.periodLabel}): ${when(i)}, ${shortDate(i.due)}${amount(d, i)}`);
  const text = [
    `Compliance reminders for ${d.company}`, '',
    ...(lines.length ? lines : ['Nothing is overdue or due soon.']), '',
    'Mark items done in Kannaku AI (Compliance calendar, key C) once filed or paid. Due dates are the standard ones in the law; check the portals for extensions.',
    '', '— Kannaku AI. You receive this because your address is in Settings → Reminders.',
  ].join('\n');
  return { subject, text };
}

export function whatsappParams(d: Digest): [string, string, string] {
  const summary = d.items.length ? `${d.overdue} overdue, ${d.dueSoon} due soon` : 'nothing due';
  const due = d.items.slice(0, 5).map((i) => `${i.title} ${shortDate(i.due)}${amount(d, i)}`).join(' | ') + (d.items.length > 5 ? ` | +${d.items.length - 5} more` : '');
  return [flat(d.company, 60), summary, flat(due || 'nothing', 900)];
}

export function smsText(d: Digest) {
  const next = d.items[0];
  // Matches TEMPLATES.sms word for word; DLT rejects messages that differ from the registered template.
  return `Kannaku AI: ${flat(d.company, 30)}: ${d.overdue} overdue, ${d.dueSoon} due soon. Next: ${flat(next?.title ?? 'none', 30)} on ${next ? shortDate(next.due) : '-'}.`;
}

// ---------- Senders (replaceable in tests) ----------

export const senders = {
  email: async (c: NotifyConfig['email'], to: string, subject: string, text: string) => {
    const transport = nodemailer.createTransport({ host: c.host, port: c.port, secure: c.secure, auth: { user: c.user, pass: c.pass }, connectionTimeout: 20_000 });
    await transport.sendMail({ from: c.from || c.user, to, subject, text });
  },
  whatsapp: async (c: NotifyConfig['whatsapp'], to: string, params: string[]) => {
    const res = await fetch(`https://graph.facebook.com/${c.apiVersion}/${c.phoneNumberId}/messages`, {
      method: 'POST', signal: AbortSignal.timeout(20_000),
      headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', to, type: 'template',
        template: { name: c.template, language: { code: c.language }, components: [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }] },
      }),
    });
    if (!res.ok) throw new Error(`WhatsApp said ${res.status}: ${(await res.text()).slice(0, 300)}`);
  },
  sms: async (c: NotifyConfig['sms'], to: string, message: string) => {
    const url = c.sendUrl.replace('{to}', encodeURIComponent(to)).replace('{message}', encodeURIComponent(message));
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`SMS provider said ${res.status}: ${(await res.text()).slice(0, 300)}`);
  },
};

async function digestFor(db: Db, companyId: string, includeAmounts: boolean): Promise<Digest> {
  const co = await one<{ name: string }>(db, `SELECT name FROM companies WHERE id = $1`, [companyId]);
  const a = await complianceAlerts(db, companyId);
  return { company: co.name, overdue: a.overdue, dueSoon: a.dueSoon, items: a.items, includeAmounts };
}

/** Sends the digest on the channels switched on (or just `only`), to every recipient; each attempt is logged. */
export async function sendDigest(db: Db, companyId: string, opts: { test?: boolean; only?: Channel; today?: string } = {}) {
  const cfg = await loadConfig(db, companyId);
  const d = await digestFor(db, companyId, cfg.includeAmounts);
  const today = opts.today ?? todayIST();
  const results: { channel: Channel; to: string; ok: boolean; error?: string }[] = [];
  const attempt = async (channel: Channel, to: string, send: () => Promise<void>) => {
    let error: string | undefined;
    try { await send(); } catch (e) { error = (e instanceof Error ? e.message : String(e)).slice(0, 500); }
    results.push({ channel, to, ok: !error, error });
    await db.query(`INSERT INTO notification_log (company_id, channel, digest_date, recipient, status, error, items, test) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [companyId, channel, today, to, error ? 'FAILED' : 'SENT', error ?? null, d.items.length, Boolean(opts.test)]);
  };
  const use = (ch: Channel, on: boolean) => (opts.only ? opts.only === ch : on);
  if (use('EMAIL', cfg.email.on)) {
    const { subject, text } = emailText(d);
    for (const to of cfg.email.to) await attempt('EMAIL', to, () => senders.email(cfg.email, to, opts.test ? `[Test] ${subject}` : subject, text));
  }
  if (use('WHATSAPP', cfg.whatsapp.on)) {
    const params = whatsappParams(d);
    for (const to of cfg.whatsapp.to) await attempt('WHATSAPP', to, () => senders.whatsapp(cfg.whatsapp, to, params));
  }
  if (use('SMS', cfg.sms.on)) {
    const text = smsText(d);
    for (const to of cfg.sms.to) await attempt('SMS', to, () => senders.sms(cfg.sms, to, text));
  }
  if (!results.length) throw new AppError('NO_CHANNEL', 422, opts.only ? 'Fill in and save that channel first' : 'Switch on at least one channel');
  return { items: d.items.length, results };
}

export async function recentLog(db: Db, companyId: string) {
  return many(db,
    `SELECT channel, digest_date::text AS date, recipient, status, error, items, test, created_at::text AS at
       FROM notification_log WHERE company_id = $1 ORDER BY id DESC LIMIT 30`, [companyId]);
}

// ---------- Daily schedule ----------

/** IST clock time "HH:MM". */
const nowIST = (now: Date) => new Date(now.getTime() + 5.5 * 3600e3).toISOString().slice(11, 16);

/**
 * Once a day, after each company's send time, sends its digest if anything is overdue or due soon and today's has
 * not gone yet. Checks every 5 minutes while the server runs (a computer that is off sends nothing).
 */
export async function runDueDigests(db: Db, now = new Date()) {
  const today = new Date(now.getTime() + 5.5 * 3600e3).toISOString().slice(0, 10);
  const companies = await many<{ company_id: string; config: unknown }>(db, `SELECT company_id, config FROM notification_settings`);
  for (const row of companies) {
    const cfg = merge(row.config);
    if (!cfg.enabled || !(cfg.email.on || cfg.whatsapp.on || cfg.sms.on) || nowIST(now) < cfg.sendAt) continue;
    const done = await maybeOne(db, `SELECT 1 FROM notification_log WHERE company_id = $1 AND digest_date = $2 AND NOT test LIMIT 1`, [row.company_id, today]);
    if (done) continue;
    const d = await digestFor(db, row.company_id, cfg.includeAmounts);
    if (!d.items.length) {
      // Nothing to say today; note it so the check does not repeat every 5 minutes.
      await db.query(`INSERT INTO notification_log (company_id, channel, digest_date, recipient, status, items) VALUES ($1,'EMAIL',$2,'(nothing due)','SENT',0)`, [row.company_id, today]);
      continue;
    }
    try { await sendDigest(db, row.company_id, { today }); } catch (e) { console.error(`[reminders] ${row.company_id}:`, e instanceof Error ? e.message : e); }
  }
}

export function scheduleDigests(db: Db) {
  const tick = () => void runDueDigests(db).catch((e) => console.error('[reminders]', e instanceof Error ? e.message : e));
  const t = setInterval(tick, 5 * 60_000);
  t.unref();
  setTimeout(tick, 30_000).unref();
}
