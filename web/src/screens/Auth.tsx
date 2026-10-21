import { useState } from 'react';
import { api, ApiError, type Status, type User } from '../api';
import { ErrorBox } from '../components/ui';
import { blankCompany, CompanyFields, companyReady, type CompanyDetails } from '../components/CompanyForm';

type Mode = 'login' | 'signup';
const DEMO = 'Sharma Building Supplies';

type OnAuthed = (u: User, openCompanyId?: string) => Promise<void>;

export function AuthScreen({ status, onAuthed }: { status: Status; onAuthed: OnAuthed }) {
  const [mode, setMode] = useState<Mode>(status.hasUsers ? 'login' : 'signup');
  return (
    <div className="auth-page">
      <div className={`auth-card ${mode === 'signup' ? 'wide' : ''}`}>
        <div className="auth-head">
          <h1 className="auth-brand">Kannaku AI</h1>
          <p className="auth-tag">GST accounting you can type, scan or speak.</p>
        </div>
        {status.demo && (
          <p className="auth-note"><strong>This is a demo.</strong> Everything entered here, including accounts, is deleted
            every night. Do not enter real business or personal details.</p>
        )}
        <div className="auth-tabs" role="tablist">
          <button role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? 'on' : ''} onClick={() => setMode('login')}>Log in</button>
          <button role="tab" aria-selected={mode === 'signup'} className={mode === 'signup' ? 'on' : ''} onClick={() => setMode('signup')}>Create account</button>
        </div>
        {mode === 'login'
          ? <LoginForm demoLogin={status.demoLogin ?? null} onAuthed={onAuthed} onSwitch={() => setMode('signup')} />
          : <SignupForm status={status} onAuthed={onAuthed} onSwitch={() => setMode('login')} />}
      </div>
    </div>
  );
}

function PasswordInput({ value, onChange, autoComplete, label, minLength }: { value: string; onChange: (v: string) => void; autoComplete: string; label: string; minLength?: number }) {
  const [show, setShow] = useState(false);
  return (
    <label>{label}
      <span className="pw">
        <input type={show ? 'text' : 'password'} value={value} onChange={(e) => onChange(e.target.value)} autoComplete={autoComplete} required minLength={minLength} />
        <button type="button" className="ghost" onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide password' : 'Show password'}>{show ? 'Hide' : 'Show'}</button>
      </span>
    </label>
  );
}

type DemoLogin = { email: string; password: string } | null;

function LoginForm({ demoLogin, onAuthed, onSwitch }: { demoLogin: DemoLogin; onAuthed: OnAuthed; onSwitch: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<{ message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (creds = { email, password }) => {
    setBusy(true); setErr(null);
    try {
      const r = await api.post<{ user: User }>('/api/v1/auth/login', creds);
      await onAuthed(r.user);
    } catch (e) { setErr({ message: e instanceof ApiError ? e.message : String(e) }); setBusy(false); }
  };
  return (
    <form className="auth-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      {demoLogin && (
        <div className="demo-login">
          <p>Demo login: <strong>{demoLogin.email}</strong> / <strong>{demoLogin.password}</strong>. Everyone trying the
            demo shares it, so others can see and change what you enter.</p>
          <button type="button" className="primary block" disabled={busy} onClick={() => void submit(demoLogin)}>Log in to the demo</button>
        </div>
      )}
      <label>Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required autoFocus /></label>
      <PasswordInput label="Password" value={password} onChange={setPassword} autoComplete="current-password" />
      <ErrorBox error={err} />
      <button type="submit" className="primary block" disabled={busy}>{busy ? 'Logging in…' : 'Log in'}</button>
      <p className="auth-switch">New to Kannaku AI? <button type="button" className="link" onClick={onSwitch}>Create an account</button></p>
    </form>
  );
}

function SignupForm({ status, onAuthed, onSwitch }: { status: Status; onAuthed: OnAuthed; onSwitch: () => void }) {
  const [me, setMe] = useState({ name: '', email: '', phone: '', password: '', confirm: '' });
  const [company, setCompany] = useState<CompanyDetails>(() => blankCompany(status.today));
  const [demo, setDemo] = useState(Boolean(status.demo));
  const [err, setErr] = useState<{ message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const demoAlreadyHere = status.unclaimed.includes(DEMO);
  const mismatch = me.confirm.length > 0 && me.confirm !== me.password;
  const ready = me.name.trim() && me.email && me.password.length >= 8 && me.password === me.confirm && companyReady(company);

  const submit = async () => {
    if (!ready) return;
    setBusy(true); setErr(null);
    try {
      const r = await api.post<{ user: User; companyId: string }>('/api/v1/auth/signup', {
        name: me.name, email: me.email, phone: me.phone || null, password: me.password,
        company: { ...company, gstin: company.gstin || null }, demo: demo && !demoAlreadyHere,
      });
      await onAuthed(r.user, r.companyId);
    } catch (e) { setErr({ message: e instanceof ApiError ? e.message : String(e) }); setBusy(false); }
  };

  return (
    <form className="auth-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <fieldset>
        <legend>About you</legend>
        <div className="form-grid">
          <label>Full name<input value={me.name} onChange={(e) => setMe({ ...me, name: e.target.value })} autoComplete="name" required autoFocus /></label>
          <label><span>Mobile <span className="opt">optional</span></span><input type="tel" value={me.phone} onChange={(e) => setMe({ ...me, phone: e.target.value })} autoComplete="tel" placeholder="98400 12345" /></label>
          <label className="span-2">Email<input type="email" value={me.email} onChange={(e) => setMe({ ...me, email: e.target.value })} autoComplete="email" required /></label>
          <PasswordInput label="Password (8+ characters)" value={me.password} onChange={(v) => setMe({ ...me, password: v })} autoComplete="new-password" minLength={8} />
          <label>Confirm password
            <input type="password" value={me.confirm} onChange={(e) => setMe({ ...me, confirm: e.target.value })} autoComplete="new-password" required aria-invalid={mismatch} />
            {mismatch && <span className="field-error">Passwords do not match</span>}
          </label>
        </div>
      </fieldset>

      <fieldset>
        <legend>Your business</legend>
        <CompanyFields value={company} onChange={setCompany} states={status.states} />
      </fieldset>

      {status.unclaimed.length > 0 && (
        <p className="auth-note">Books already on this computer will be added to your account: <strong>{status.unclaimed.join(', ')}</strong>.</p>
      )}
      {!demoAlreadyHere && (
        <label className="check">
          <input type="checkbox" checked={demo} onChange={(e) => setDemo(e.target.checked)} />
          Also add a sample company ({DEMO}) with three months of entries to explore
        </label>
      )}
      <ErrorBox error={err} />
      <button type="submit" className="primary block" disabled={busy || !ready}>{busy ? 'Creating your books…' : 'Create account'}</button>
      <p className="auth-switch">Already have an account? <button type="button" className="link" onClick={onSwitch}>Log in</button></p>
    </form>
  );
}
