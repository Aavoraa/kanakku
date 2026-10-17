import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type User } from '../api';
import { useApp } from '../state';
import { ErrorBox, ScreenHead } from '../components/ui';
import { fmtDate } from '../format';

type Err = { message: string; details?: unknown } | null;
const asErr = (e: unknown): Err => (e instanceof ApiError ? { message: e.message, details: e.details } : { message: String(e) });

/** The signed-in person's own details: name, mobile, email (login), password, and where they are signed in. */
export function Profile() {
  return (
    <div className="settings">
      <ScreenHead title="My profile" sub="Your own login. Business details are in Company settings." />
      <Details />
      <Password />
      <Sessions />
    </div>
  );
}

function Details() {
  const app = useApp();
  const [name, setName] = useState(app.user.name);
  const [phone, setPhone] = useState(app.user.phone ?? '');
  const [email, setEmail] = useState(app.user.email);
  const [currentPassword, setCurrentPassword] = useState('');
  const [err, setErr] = useState<Err>(null);
  const [busy, setBusy] = useState(false);
  const emailChanged = email.trim().toLowerCase() !== app.user.email;
  const save = async () => {
    setBusy(true);
    try {
      const r = await api.patch<{ user: User }>('/api/v1/account/profile', { name, phone: phone || null, email, currentPassword: emailChanged ? currentPassword : undefined });
      app.setUser(r.user);
      setEmail(r.user.email);
      setCurrentPassword('');
      setErr(null);
      app.toast(emailChanged ? `Saved. Log in with ${r.user.email} from now on.` : 'Profile saved');
    } catch (e) { setErr(asErr(e)); } finally { setBusy(false); }
  };
  return (
    <form className="form-grid narrow" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <label>Your name<input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required autoComplete="name" /></label>
      <label>Mobile number<input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" autoComplete="tel" placeholder="Optional" /></label>
      <label className="span-2">Email (you log in with this)<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" /></label>
      {emailChanged && (
        <label className="span-2">Current password, to change the email
          <input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required autoComplete="current-password" />
        </label>
      )}
      <ErrorBox error={err} />
      <div className="form-actions"><button className="primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button></div>
    </form>
  );
}

function Password() {
  const app = useApp();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [err, setErr] = useState<Err>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (next !== again) { setErr({ message: 'The two new passwords do not match' }); return; }
    setBusy(true);
    try {
      const r = await api.post<{ signedOut: number }>('/api/v1/account/password', { currentPassword: current, newPassword: next });
      setCurrent(''); setNext(''); setAgain(''); setErr(null);
      app.toast(r.signedOut ? `Password changed. Signed out ${r.signedOut} other browser${r.signedOut === 1 ? '' : 's'}.` : 'Password changed');
      app.bumpData();
    } catch (e) { setErr(asErr(e)); } finally { setBusy(false); }
  };
  return (
    <>
      <h3>Change password</h3>
      <form className="form-grid narrow" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <label className="span-2">Current password<input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} required autoComplete="current-password" /></label>
        <label>New password<input type="password" value={next} onChange={(e) => setNext(e.target.value)} minLength={8} required autoComplete="new-password" /></label>
        <label>New password again<input type="password" value={again} onChange={(e) => setAgain(e.target.value)} minLength={8} required autoComplete="new-password" /></label>
        <p className="muted small span-2">At least 8 characters. Other browsers signed in to your account are signed out; this one stays signed in.
          Forgotten it? The administrator can set a new one on this computer with <code>npm run reset-password</code>.</p>
        <ErrorBox error={err} />
        <div className="form-actions"><button className="primary" type="submit" disabled={busy}>{busy ? 'Changing…' : 'Change password'}</button></div>
      </form>
    </>
  );
}

interface Session { signedInAt: string; expiresAt: string; browser: string; current: boolean }

function Sessions() {
  const app = useApp();
  const [list, setList] = useState<Session[] | null>(null);
  const load = useCallback(() => api.get<Session[]>('/api/v1/account/sessions').then(setList).catch(() => setList([])), []);
  useEffect(() => { void load(); }, [load, app.dataVersion]);
  const others = list?.filter((s) => !s.current).length ?? 0;
  const signOutOthers = async () => {
    try {
      const r = await api.post<{ signedOut: number }>('/api/v1/account/sessions/sign-out-others', {});
      app.toast(`Signed out ${r.signedOut} other browser${r.signedOut === 1 ? '' : 's'}`);
      await load();
    } catch (e) { app.toast(e instanceof ApiError ? e.message : String(e), 'error'); }
  };
  return (
    <>
      <h3>Signed in</h3>
      {list && (
        <table className="list">
          <thead><tr><th>Browser</th><th>Signed in</th><th>Expires</th><th /></tr></thead>
          <tbody>{list.map((s, i) => (
            <tr key={i}><td>{s.browser}</td><td>{fmtDate(s.signedInAt)}</td><td>{fmtDate(s.expiresAt)}</td><td>{s.current && <span className="pill matched">this browser</span>}</td></tr>
          ))}</tbody>
        </table>
      )}
      {others > 0 && <p><button onClick={() => void signOutOthers()}>Sign out everywhere else</button></p>}
    </>
  );
}
