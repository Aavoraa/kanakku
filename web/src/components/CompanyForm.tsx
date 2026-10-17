import { useState } from 'react';
import { api, ApiError } from '../api';
import { fyStart, todayIST } from '../format';
import { ErrorBox } from './ui';

export interface CompanyDetails { name: string; gstin: string; stateCode: string; booksFrom: string }

const CS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
/** Same mod-36 check as the server, for instant feedback while typing. */
export function gstinProblem(g: string): string | null {
  if (!g) return null;
  if (g.length < 15) return 'A GSTIN has 15 characters';
  if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g)) return 'That does not look like a GSTIN (e.g. 33ABCDE1234F1Z5)';
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const p = CS.indexOf(g[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return CS[(36 - (sum % 36)) % 36] === g[14] ? null : 'The last character (check digit) does not match; please re-check the GSTIN';
}

export const blankCompany = (today: string): CompanyDetails => ({ name: '', gstin: '', stateCode: '', booksFrom: fyStart(today) });

/** Business name, GSTIN, state and books start date. State follows the GSTIN when one is entered. */
export function CompanyFields({ value, onChange, states, autoFocus }: {
  value: CompanyDetails; onChange: (v: CompanyDetails) => void; states: Record<string, string>; autoFocus?: boolean;
}) {
  const problem = gstinProblem(value.gstin);
  const stateFromGstin = value.gstin && !problem ? value.gstin.slice(0, 2) : null;
  return (
    <div className="form-grid">
      <label className="span-2">Business name
        <input value={value.name} onChange={(e) => onChange({ ...value, name: e.target.value })} required autoComplete="organization" autoFocus={autoFocus} placeholder="As it appears on your invoices" />
      </label>
      <label><span>GSTIN <span className="opt">optional</span></span>
        <input value={value.gstin} maxLength={15} autoComplete="off" spellCheck={false} placeholder="Leave empty if not registered"
          onChange={(e) => {
            const g = e.target.value.toUpperCase().replace(/\s/g, '');
            onChange({ ...value, gstin: g, stateCode: g.length >= 2 && states[g.slice(0, 2)] ? g.slice(0, 2) : value.stateCode });
          }}
          aria-invalid={Boolean(problem && value.gstin.length === 15)} />
        {problem && value.gstin.length === 15 && <span className="field-error">{problem}</span>}
      </label>
      <label>State
        <select value={stateFromGstin ?? value.stateCode} onChange={(e) => onChange({ ...value, stateCode: e.target.value })} required disabled={Boolean(stateFromGstin)}>
          <option value="">Choose…</option>
          {Object.entries(states).map(([k, v]) => <option key={k} value={k}>{v} ({k})</option>)}
        </select>
        {stateFromGstin && <span className="field-note">From the GSTIN</span>}
      </label>
      <label>Books start from
        <input type="date" value={value.booksFrom} onChange={(e) => onChange({ ...value, booksFrom: e.target.value })} required />
        <span className="field-note">Usually 1 April of the year you start using Kannaku AI</span>
      </label>
    </div>
  );
}

export const companyReady = (c: CompanyDetails) => Boolean(c.name.trim() && (c.gstin ? !gstinProblem(c.gstin) : c.stateCode) && c.booksFrom);

/** Stand-alone "add a business" form for logged-in users. */
export function CompanyForm({ states, submitLabel, onCreated }: { states: Record<string, string>; submitLabel: string; onCreated: (id: string) => void }) {
  const [value, setValue] = useState<CompanyDetails>(() => blankCompany(todayIST()));
  const [err, setErr] = useState<{ message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ id: string }>('/api/v1/companies', { ...value, gstin: value.gstin || null });
      onCreated(r.id);
    } catch (e) { setErr({ message: e instanceof ApiError ? e.message : String(e) }); }
    finally { setBusy(false); }
  };
  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <CompanyFields value={value} onChange={setValue} states={states} autoFocus />
      <ErrorBox error={err} />
      <div className="form-actions"><button type="submit" className="primary" disabled={busy || !companyReady(value)}>{busy ? 'Creating…' : submitLabel}</button></div>
    </form>
  );
}
