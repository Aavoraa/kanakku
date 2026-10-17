import { useCallback, useEffect, useState } from 'react';
import { api, c, ApiError, type ComplianceItem, type ComplianceSettings, type ComplianceTask } from '../api';
import { useApp } from '../state';
import { Empty, ErrorBox, ScreenHead } from '../components/ui';
import { addDays, fmtDate, fromMinor, inr } from '../format';
import { Reminders } from '../components/Reminders';
import { desktopOn, desktopSupported, disableDesktop, dueText, enableDesktop } from '../notify';

interface View { from: string; to: string; today: string; settings: ComplianceSettings; items: ComplianceItem[]; tasks: ComplianceTask[] }
type Err = { message: string; details?: unknown } | null;
const asErr = (e: unknown): Err => (e instanceof ApiError ? { message: e.message, details: e.details } : { message: String(e) });

const CATEGORY_LABEL: Record<string, string> = { GST: 'GST', TDS: 'TDS', INCOME_TAX: 'Income tax', TASK: 'Reminder', ASSET: 'Asset upkeep', CASH: 'Petty cash' };
const TASK_CATEGORIES: [string, string][] = [
  ['WORKING', 'Working'], ['CALCULATION', 'Calculation'], ['ADJUSTMENT', 'Adjustment'], ['FILING', 'Filing'], ['PAYMENT', 'Payment'], ['OTHER', 'Other'],
];
/** What the reference number is called for each kind of filing. */
const REF_LABEL: Record<string, string> = {
  GSTR1: 'ARN', GSTR3B: 'ARN (and challan CPIN/CIN if paid)', GSTR9: 'ARN', PMT06: 'Challan CPIN / CIN',
  TDS_PAY: 'Challan CIN / BSR code', TDS_RETURN: 'Token / receipt no.', ADV_TAX: 'Challan CIN / BSR code',
  ITR: 'Acknowledgement no.', TAX_AUDIT: 'Acknowledgement no.', TASK: 'Reference (optional)',
};
const PAYS = new Set(['GSTR3B', 'PMT06', 'TDS_PAY', 'ADV_TAX', 'ITR']);

/** GST, TDS and income-tax due dates, filing records (ARN, challan, amount) and the company's own reminders. */
export function Compliance() {
  const app = useApp();
  const [start, setStart] = useState(() => addDays(app.status.today, -31));
  const [view, setView] = useState<View | null>(null);
  const [err, setErr] = useState<Err>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showReminders, setShowReminders] = useState(false);
  const to = addDays(start, 123);

  const load = useCallback(async () => {
    try { setView(await api.get<View>(c(`/compliance?from=${start}&to=${to}`))); setErr(null); } catch (e) { setErr(asErr(e)); }
  }, [start, to]);
  useEffect(() => { void load(); }, [load, app.dataVersion]);
  /** Saved something: reload here and refresh the bell. */
  const changed = async () => { await load(); app.bumpData(); };

  const attention = view?.items.filter((i) => i.status === 'OVERDUE' || i.status === 'DUE_SOON') ?? [];
  const upcoming = view?.items.filter((i) => i.status === 'UPCOMING') ?? [];
  const done = view?.items.filter((i) => i.status === 'DONE') ?? [];

  return (
    <div className="compliance">
      <ScreenHead title="Compliance calendar" sub={`${fmtDate(start)} to ${fmtDate(to)} · GST, TDS and income tax due dates, and your own reminders`}>
        <button onClick={() => setStart(addDays(start, -91))}>← Earlier</button>
        <button onClick={() => setStart(addDays(app.status.today, -31))}>Now</button>
        <button onClick={() => setStart(addDays(start, 91))}>Later →</button>
        <button onClick={() => setShowSettings((s) => !s)} aria-expanded={showSettings}>Which returns apply</button>
        <button onClick={() => setShowReminders((s) => !s)} aria-expanded={showReminders}>Email / WhatsApp / SMS reminders</button>
      </ScreenHead>
      <ErrorBox error={err} />
      {showSettings && view && <SettingsCard settings={view.settings} hasGstin={Boolean(app.company.gstin)} onSaved={changed} />}
      {showReminders && <Reminders />}
      <p className="hint-bar">These are the standard due dates in the law. The government often extends them: check
        {' '}<a href="https://www.gst.gov.in" target="_blank" rel="noreferrer">gst.gov.in</a> and
        {' '}<a href="https://www.incometax.gov.in" target="_blank" rel="noreferrer">incometax.gov.in</a>, and use <em>Change due date</em> when they do.
        Amounts shown are worked out from your books; check them before you pay.</p>
      <DesktopToggle />

      {!view ? <p className="muted">Loading…</p> : <>
        <h3>Needs attention</h3>
        {attention.length === 0 ? <Empty>Nothing overdue or due soon in this period.</Empty> : <ItemList items={attention} onChanged={changed} />}
        <h3>Coming up</h3>
        {upcoming.length === 0 ? <Empty>Nothing else falls due in this period.</Empty> : <ItemList items={upcoming} onChanged={changed} />}
        <h3>Done</h3>
        {done.length === 0 ? <Empty>Nothing marked filed or done in this period yet.</Empty> : <ItemList items={done} onChanged={changed} />}
        <h3>Your reminders</h3>
        <p className="muted small">Workings, calculations, adjustments and anything else with a date: they show in the bell and on this calendar.</p>
        <TaskForm today={view.today} onSaved={changed} />
        {view.tasks.length > 0 && <TaskList tasks={view.tasks} onChanged={changed} />}
      </>}
    </div>
  );
}

function statusText(i: ComplianceItem) {
  if (i.status === 'DONE') return `Done ${i.record?.doneOn ? fmtDate(i.record.doneOn) : ''}`;
  return dueText(i);
}

function ItemList({ items, onChanged }: { items: ComplianceItem[]; onChanged: () => Promise<void> }) {
  return (
    <table className="list compliance-list">
      <thead><tr><th>Due</th><th>What</th><th>Period</th><th>Status</th><th className="num">Amount ₹</th><th /></tr></thead>
      <tbody>{items.map((i) => <ItemRow key={i.key} item={i} onChanged={onChanged} />)}</tbody>
    </table>
  );
}

function ItemRow({ item: i, onChanged }: { item: ComplianceItem; onChanged: () => Promise<void> }) {
  const app = useApp();
  const [mode, setMode] = useState<null | 'done' | 'due'>(null);
  const [err, setErr] = useState<Err>(null);
  const [busy, setBusy] = useState(false);
  const save = async (patch: Record<string, unknown>) => {
    setBusy(true);
    try { await api.put(c(`/compliance/records/${encodeURIComponent(i.key)}`), patch); setMode(null); setErr(null); await onChanged(); }
    catch (e) { setErr(asErr(e)); } finally { setBusy(false); }
  };
  const amount = i.record?.amountMinor ?? i.estimateMinor;
  return (
    <>
      <tr className={`cmp-${i.status.toLowerCase()}`}>
        <td className="nowrap">{fmtDate(i.due)}{i.extended && <span className="tag" title={`Statutory date ${fmtDate(i.dueDate)}`}>extended</span>}</td>
        <td>{i.title}<span className="tag">{i.category === 'TASK' ? (i.taskCategory ?? 'Reminder').toLowerCase() : CATEGORY_LABEL[i.category]}</span>{i.kind === 'ASSET' && <button className="link small" onClick={() => app.go({ screen: 'assets' })}>asset</button>}
          {i.record?.reference && <div className="muted small">Ref {i.record.reference}</div>}
          {(i.record?.notes || i.notes) && <div className="muted small">{i.record?.notes ?? i.notes}</div>}</td>
        <td className="nowrap">{i.periodLabel}</td>
        <td><span className={`status cmp-st-${i.status.toLowerCase()}`}>{statusText(i)}</span></td>
        <td className="num">{amount !== null && amount !== undefined ? inr(amount) : ''}
          {i.record?.amountMinor == null && i.estimateMinor !== null && <div className="muted small">from the books</div>}</td>
        <td className="nowrap row-actions">
          {i.status === 'DONE'
            ? <button disabled={busy} onClick={() => { if (window.confirm('Mark this as not done? The filing details will be cleared.')) void save({ doneOn: null, reference: null, amount: null, notes: null }); }}>Undo</button>
            : <>
              <button className="primary" onClick={() => setMode(mode === 'done' ? null : 'done')}>Mark done</button>
              <button onClick={() => setMode(mode === 'due' ? null : 'due')}>Change due date</button>
            </>}
        </td>
      </tr>
      {mode && (
        <tr className="sub-row"><td colSpan={6}>
          {mode === 'done' ? <DoneForm item={i} busy={busy} onSave={save} onCancel={() => setMode(null)} />
            : <DueForm item={i} busy={busy} onSave={save} onCancel={() => setMode(null)} />}
          <ErrorBox error={err} />
        </td></tr>
      )}
    </>
  );
}

function DoneForm({ item: i, busy, onSave, onCancel }: { item: ComplianceItem; busy: boolean; onSave: (p: Record<string, unknown>) => void; onCancel: () => void }) {
  const app = useApp();
  const [doneOn, setDoneOn] = useState(app.status.today);
  const [reference, setReference] = useState('');
  const [amount, setAmount] = useState(i.estimateMinor && PAYS.has(i.kind) ? fromMinor(BigInt(i.estimateMinor)) : '');
  const [notes, setNotes] = useState('');
  return (
    <form className="inline-form" onSubmit={(e) => { e.preventDefault(); onSave({ doneOn, reference, amount: PAYS.has(i.kind) ? amount : null, notes }); }}>
      <label>{i.kind === 'TASK' ? 'Done on' : 'Filed / paid on'}<input type="date" value={doneOn} max={app.status.today} onChange={(e) => setDoneOn(e.target.value)} required /></label>
      <label>{REF_LABEL[i.kind] ?? 'Reference'}<input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={100} /></label>
      {PAYS.has(i.kind) && <label>Amount paid (₹)<input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="0 if nothing was due" /></label>}
      <label className="grow">Note<input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} /></label>
      <button type="submit" className="primary" disabled={busy}>Save</button>
      <button type="button" onClick={onCancel}>Cancel</button>
    </form>
  );
}

function DueForm({ item: i, busy, onSave, onCancel }: { item: ComplianceItem; busy: boolean; onSave: (p: Record<string, unknown>) => void; onCancel: () => void }) {
  const [due, setDue] = useState(i.due);
  return (
    <form className="inline-form" onSubmit={(e) => { e.preventDefault(); onSave({ dueDate: due === i.dueDate ? null : due }); }}>
      <label>New due date (as extended by the government)<input type="date" value={due} onChange={(e) => setDue(e.target.value)} required /></label>
      <button type="submit" className="primary" disabled={busy}>Save</button>
      {i.extended && <button type="button" disabled={busy} onClick={() => onSave({ dueDate: null })}>Back to {fmtDate(i.dueDate)}</button>}
      <button type="button" onClick={onCancel}>Cancel</button>
    </form>
  );
}

function SettingsCard({ settings, hasGstin, onSaved }: { settings: ComplianceSettings; hasGstin: boolean; onSaved: () => Promise<void> }) {
  const app = useApp();
  const [s, setS] = useState(settings);
  const [err, setErr] = useState<Err>(null);
  const flag = (k: keyof ComplianceSettings) => (e: { target: { checked: boolean } }) => setS({ ...s, [k]: e.target.checked });
  const save = async () => {
    try { await api.put(c('/compliance/settings'), s); setErr(null); app.toast('Compliance settings saved'); await onSaved(); } catch (e) { setErr(asErr(e)); }
  };
  return (
    <form className="form-grid narrow cmp-settings" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      {!hasGstin && <p className="muted small span-2">GST reminders appear once the company has a GSTIN (Settings).</p>}
      <label className="check"><input type="checkbox" checked={s.gst} onChange={flag('gst')} /> GST returns (GSTR-1, GSTR-3B)</label>
      <label>Filing frequency
        <select value={s.gstFrequency} onChange={(e) => setS({ ...s, gstFrequency: e.target.value as ComplianceSettings['gstFrequency'] })} disabled={!s.gst}>
          <option value="MONTHLY">Monthly</option>
          <option value="QUARTERLY">Quarterly (QRMP, with PMT-06 monthly payments)</option>
        </select>
      </label>
      <label className="check"><input type="checkbox" checked={s.gstAnnual} onChange={flag('gstAnnual')} disabled={!s.gst} /> GSTR-9 annual return</label>
      <label className="check"><input type="checkbox" checked={s.tds} onChange={flag('tds')} /> TDS / TCS (monthly payment, quarterly returns)</label>
      <label className="check"><input type="checkbox" checked={s.incomeTax} onChange={flag('incomeTax')} /> Income-tax return</label>
      <label className="check"><input type="checkbox" checked={s.advanceTax} onChange={flag('advanceTax')} disabled={!s.incomeTax} /> Advance tax instalments</label>
      <label className="check"><input type="checkbox" checked={s.taxAudit} onChange={flag('taxAudit')} disabled={!s.incomeTax} /> Accounts are tax-audited (s.44AB): later ITR date and the audit report</label>
      <label>Remind this many days before<input type="number" min={0} max={30} value={s.remindDays} onChange={(e) => setS({ ...s, remindDays: Number(e.target.value) })} /></label>
      <ErrorBox error={err} />
      <div className="form-actions"><button className="primary" type="submit">Save</button></div>
    </form>
  );
}

/** Opt-in OS pop-ups; the browser asks for permission. Nothing leaves this computer. */
function DesktopToggle() {
  const app = useApp();
  const [on, setOn] = useState(desktopOn);
  if (!desktopSupported()) return null;
  const blocked = Notification.permission === 'denied';
  return (
    <p className="small">
      {on
        ? <>Desktop pop-ups are on for this browser. <button className="link" onClick={() => { disableDesktop(); setOn(false); }}>Turn off</button></>
        : blocked
          ? <span className="muted">Desktop pop-ups are blocked for this site in the browser&rsquo;s settings.</span>
          : <button onClick={() => void enableDesktop().then((ok) => { setOn(ok); if (ok) app.bumpData(); })}>Show desktop pop-ups for due dates</button>}
      <span className="muted"> They appear while Kannaku AI is open in a tab, once a day for each item overdue or due within two days. They show on this
        computer only, and may be visible on its lock screen.</span>
    </p>
  );
}

function TaskForm({ today, onSaved }: { today: string; onSaved: () => Promise<void> }) {
  const blank = { title: '', category: 'WORKING', firstDue: today, repeat: 'MONTHLY', remindDays: '3', notes: '' };
  const [f, setF] = useState(blank);
  const [err, setErr] = useState<Err>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    try { await api.post(c('/compliance/tasks'), { ...f, remindDays: Number(f.remindDays) }); setF(blank); setErr(null); await onSaved(); } catch (e) { setErr(asErr(e)); }
  };
  return (
    <form className="inline-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <label className="grow">Reminder<input value={f.title} onChange={set('title')} placeholder="e.g. Depreciation working, bank reconciliation, provision for expenses" maxLength={200} required /></label>
      <label>Type<select value={f.category} onChange={set('category')}>{TASK_CATEGORIES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <label>First due<input type="date" value={f.firstDue} onChange={set('firstDue')} required /></label>
      <label>Repeats<select value={f.repeat} onChange={set('repeat')}>
        <option value="NONE">Once</option><option value="MONTHLY">Every month</option><option value="QUARTERLY">Every quarter</option><option value="YEARLY">Every year</option>
      </select></label>
      <label>Remind days before<input type="number" min={0} max={60} value={f.remindDays} onChange={set('remindDays')} /></label>
      <label className="grow">Note<input value={f.notes} onChange={set('notes')} maxLength={1000} /></label>
      <button type="submit" className="primary">Add reminder</button>
      <ErrorBox error={err} />
    </form>
  );
}

function TaskList({ tasks, onChanged }: { tasks: ComplianceTask[]; onChanged: () => Promise<void> }) {
  const app = useApp();
  const remove = async (t: ComplianceTask) => {
    if (!window.confirm(`Stop the reminder "${t.title}"? Past records of it are kept.`)) return;
    try { await api.delete(c(`/compliance/tasks/${t.id}`)); await onChanged(); } catch (e) { app.toast(e instanceof ApiError ? e.message : String(e), 'error'); }
  };
  const every: Record<string, string> = { NONE: 'once', MONTHLY: 'every month', QUARTERLY: 'every quarter', YEARLY: 'every year' };
  return (
    <table className="list">
      <thead><tr><th>Reminder</th><th>Type</th><th>From</th><th>Repeats</th><th>Remind</th><th /></tr></thead>
      <tbody>{tasks.map((t) => (
        <tr key={t.id}><td>{t.title}{t.notes && <div className="muted small">{t.notes}</div>}</td><td>{t.category.toLowerCase()}</td>
          <td>{fmtDate(t.firstDue)}</td><td>{every[t.repeat]}</td><td>{t.remindDays} days before</td>
          <td><button onClick={() => void remove(t)}>Stop</button></td></tr>
      ))}</tbody>
    </table>
  );
}
