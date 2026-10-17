import { useCallback, useEffect, useState } from 'react';
import { api, c, ApiError } from '../api';
import { useApp } from '../state';
import { ErrorBox } from './ui';

interface Cfg {
  enabled: boolean; sendAt: string; includeAmounts: boolean;
  email: { on: boolean; to: string[]; host: string; port: number; secure: boolean; user: string; from: string; hasPass: boolean };
  whatsapp: { on: boolean; to: string[]; phoneNumberId: string; template: string; language: string; apiVersion: string; hasToken: boolean };
  sms: { on: boolean; to: string[]; hasSendUrl: boolean; sendUrlHost: string | null };
}
interface LogRow { channel: string; date: string; recipient: string; status: string; error: string | null; items: number; test: boolean; at: string }
interface View { config: Cfg; templates: { whatsapp: string; sms: string }; log: LogRow[] }
type Err = { message: string; details?: unknown } | null;
const asErr = (e: unknown): Err => (e instanceof ApiError ? { message: e.message, details: e.details } : { message: String(e) });

/** Daily digest of what is overdue or due soon, by email, WhatsApp and SMS, through the company's own provider accounts. */
export function Reminders() {
  const app = useApp();
  const [v, setV] = useState<View | null>(null);
  const [f, setF] = useState<Cfg | null>(null);
  const [secrets, setSecrets] = useState({ pass: '', token: '', sendUrl: '' });
  const [err, setErr] = useState<Err>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const r = await api.get<View>(c('/notifications'));
    setV(r); setF(r.config);
  }, []);
  useEffect(() => { void load().catch((e) => setErr(asErr(e))); }, [load]);
  if (!v || !f) return <ErrorBox error={err} />;

  const save = async () => {
    setBusy(true);
    try {
      await api.put(c('/notifications'), {
        ...f,
        email: { ...f.email, to: f.email.to, pass: secrets.pass || undefined },
        whatsapp: { ...f.whatsapp, token: secrets.token || undefined },
        sms: { ...f.sms, sendUrl: secrets.sendUrl || undefined },
      });
      setSecrets({ pass: '', token: '', sendUrl: '' }); setErr(null); app.toast('Reminder settings saved'); await load();
    } catch (e) { setErr(asErr(e)); } finally { setBusy(false); }
  };
  const test = async (channel: 'EMAIL' | 'WHATSAPP' | 'SMS') => {
    setBusy(true);
    try {
      const r = await api.post<{ results: { to: string; ok: boolean; error?: string }[] }>(c('/notifications/test'), { channel });
      const bad = r.results.filter((x) => !x.ok);
      app.toast(bad.length ? `${bad.length} of ${r.results.length} failed: ${bad[0].error}` : `Test sent to ${r.results.map((x) => x.to).join(', ')}`, bad.length ? 'error' : 'ok');
      await load();
    } catch (e) { setErr(asErr(e)); } finally { setBusy(false); }
  };
  const toText = (a: string[]) => a.join(', ');
  const fromText = (s: string) => s.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
  const setE = (p: Partial<Cfg['email']>) => setF({ ...f, email: { ...f.email, ...p } });
  const setW = (p: Partial<Cfg['whatsapp']>) => setF({ ...f, whatsapp: { ...f.whatsapp, ...p } });
  const setS = (p: Partial<Cfg['sms']>) => setF({ ...f, sms: { ...f.sms, ...p } });

  return (
    <form className="reminders" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <p className="small">A daily message listing what is overdue or due soon (the same list as the bell), sent at the time you choose while
        Kannaku AI is running. It contains your company name, what is due and when{f.includeAmounts ? ', and the GST amounts' : ''}. It goes through
        your own accounts: your mail provider, Meta (WhatsApp) or your SMS provider, under their terms.</p>
      <div className="form-grid narrow">
        <label className="check"><input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> Send a daily reminder</label>
        <label>At (IST)<input type="time" value={f.sendAt} onChange={(e) => setF({ ...f, sendAt: e.target.value })} /></label>
        <label className="check span-2"><input type="checkbox" checked={f.includeAmounts} onChange={(e) => setF({ ...f, includeAmounts: e.target.checked })} /> Include GST amounts worked out from the books</label>
      </div>

      <fieldset>
        <legend><label className="check"><input type="checkbox" checked={f.email.on} onChange={(e) => setE({ on: e.target.checked })} /> Email</label></legend>
        <div className="form-grid">
          <label className="span-2">Send to (comma between addresses)<input value={toText(f.email.to)} onChange={(e) => setE({ to: fromText(e.target.value) })} placeholder="you@example.com, ca@example.com" /></label>
          <label>Mail server (SMTP)<input value={f.email.host} onChange={(e) => setE({ host: e.target.value })} placeholder="smtp.gmail.com" /></label>
          <label>Port<input value={String(f.email.port)} onChange={(e) => setE({ port: Number(e.target.value) || 587, secure: e.target.value === '465' })} inputMode="numeric" /></label>
          <label>User name<input value={f.email.user} onChange={(e) => setE({ user: e.target.value })} autoComplete="off" /></label>
          <label>Password{f.email.hasPass ? ' (saved; leave blank to keep)' : ''}<input type="password" value={secrets.pass} onChange={(e) => setSecrets({ ...secrets, pass: e.target.value })} autoComplete="new-password" /></label>
          <label className="span-2">From address (optional)<input value={f.email.from} onChange={(e) => setE({ from: e.target.value })} placeholder={f.email.user || 'reminders@yourfirm.in'} /></label>
        </div>
        <p className="muted small">Gmail: server smtp.gmail.com, port 587, your Gmail address, and an <em>app password</em> (Google Account → Security → 2-Step
          Verification → App passwords), not your normal password.</p>
        <button type="button" onClick={() => void test('EMAIL')} disabled={busy || !f.email.on}>Send a test email</button>
      </fieldset>

      <fieldset>
        <legend><label className="check"><input type="checkbox" checked={f.whatsapp.on} onChange={(e) => setW({ on: e.target.checked })} /> WhatsApp</label></legend>
        <div className="form-grid">
          <label className="span-2">Send to (numbers with country code)<input value={toText(f.whatsapp.to)} onChange={(e) => setW({ to: fromText(e.target.value) })} placeholder="91 98400 12345" /></label>
          <label>Phone number ID<input value={f.whatsapp.phoneNumberId} onChange={(e) => setW({ phoneNumberId: e.target.value.trim() })} inputMode="numeric" /></label>
          <label>Access token{f.whatsapp.hasToken ? ' (saved; leave blank to keep)' : ''}<input type="password" value={secrets.token} onChange={(e) => setSecrets({ ...secrets, token: e.target.value })} autoComplete="off" /></label>
          <label>Template name<input value={f.whatsapp.template} onChange={(e) => setW({ template: e.target.value.trim() })} /></label>
          <label>Template language<input value={f.whatsapp.language} onChange={(e) => setW({ language: e.target.value.trim() })} placeholder="en" /></label>
          <label>Graph API version<input value={f.whatsapp.apiVersion} onChange={(e) => setW({ apiVersion: e.target.value.trim() })} placeholder="v24.0" /></label>
        </div>
        <p className="muted small">Needs a WhatsApp Business account in Meta (developers.facebook.com → WhatsApp → API setup) with a verified number, a permanent access
          token, and a <strong>Utility</strong> message template approved by Meta with this body: <code>{v.templates.whatsapp}</code>. Meta charges per message.
          Meta retires Graph API versions about two years after release; raise the version here when it asks.</p>
        <button type="button" onClick={() => void test('WHATSAPP')} disabled={busy || !f.whatsapp.on}>Send a test WhatsApp</button>
      </fieldset>

      <fieldset>
        <legend><label className="check"><input type="checkbox" checked={f.sms.on} onChange={(e) => setS({ on: e.target.checked })} /> SMS</label></legend>
        <div className="form-grid">
          <label className="span-2">Send to (mobile numbers)<input value={toText(f.sms.to)} onChange={(e) => setS({ to: fromText(e.target.value) })} placeholder="98400 12345" /></label>
          <label className="span-2">Provider's send link{f.sms.hasSendUrl ? ` (saved: ${f.sms.sendUrlHost}; leave blank to keep)` : ''}
            <input type="password" value={secrets.sendUrl} onChange={(e) => setSecrets({ ...secrets, sendUrl: e.target.value })} autoComplete="off"
              placeholder="https://api.provider.in/send?apikey=…&sender=KANAKU&template_id=…&to={to}&message={message}" />
          </label>
        </div>
        <p className="muted small">SMS in India needs DLT registration with your provider (entity, sender ID and this template, as a Service-Implicit
          message): <code>{v.templates.sms}</code>. Paste the provider's send link with your key, sender ID and template ID, and write {'{to}'} and
          {' {message}'} where the number and the text go.</p>
        <button type="button" onClick={() => void test('SMS')} disabled={busy || !f.sms.on}>Send a test SMS</button>
      </fieldset>

      <ErrorBox error={err} />
      <div className="form-actions"><button className="primary" type="submit" disabled={busy}>Save reminder settings</button></div>

      {v.log.length > 0 && <>
        <h3>Sent recently</h3>
        <table className="list">
          <thead><tr><th>When</th><th>Channel</th><th>To</th><th className="num">Items</th><th>Result</th></tr></thead>
          <tbody>{v.log.map((l, i) => (
            <tr key={i}><td>{l.at.slice(0, 16)}{l.test && <small className="tag">test</small>}</td><td>{l.channel.toLowerCase()}</td><td>{l.recipient}</td>
              <td className="num">{l.items}</td><td className={l.status === 'FAILED' ? 'bad' : 'ok'}>{l.status === 'FAILED' ? l.error : 'sent'}</td></tr>
          ))}</tbody>
        </table>
      </>}
    </form>
  );
}
