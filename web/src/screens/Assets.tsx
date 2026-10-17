import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, c, ApiError, type ComplianceItem } from '../api';
import { useApp } from '../state';
import { Picker, type Option } from '../components/Picker';
import { Empty, ErrorBox, Modal, ScreenHead } from '../components/ui';
import { addDays, fmtDate, inr, uid } from '../format';
import { dueText } from '../notify';

interface Asset {
  id: string; name: string; category: string | null; ledgerId: string | null; ledgerName: string | null; location: string | null; serialNo: string | null;
  purchaseDate: string | null; costMinor: string | null; notes: string | null; active: boolean; nextDue: string | null; upkeepMinor: string; lastUpkeep: string | null;
}
interface Schedule { id: string; kind: string; title: string; nextDue: string; repeat: string; remindDays: number; vendor: string | null; notes: string | null }
interface Log { id: string; date: string; kind: string; description: string; costMinor: string | null; vendor: string | null; voucherNo: string | null; voucherId: string | null }
type Err = { message: string; details?: unknown } | null;
const asErr = (e: unknown): Err => (e instanceof ApiError ? { message: e.message, details: e.details } : { message: String(e) });

const KINDS: [string, string][] = [['SERVICE', 'Service'], ['AMC', 'AMC renewal'], ['INSURANCE', 'Insurance renewal'], ['WARRANTY', 'Warranty ends'], ['LICENCE', 'Licence / permit renewal'], ['INSPECTION', 'Inspection'], ['OTHER', 'Other']];
const LOG_KINDS: [string, string][] = [['REPAIR', 'Repair'], ['SERVICE', 'Service'], ['AMC', 'AMC'], ['INSURANCE', 'Insurance'], ['INSPECTION', 'Inspection'], ['OTHER', 'Other']];
const REPEATS: [string, string][] = [['NONE', 'Once'], ['MONTHLY', 'Every month'], ['QUARTERLY', 'Every quarter'], ['HALF_YEARLY', 'Every 6 months'], ['YEARLY', 'Every year']];
const label = (list: [string, string][], k: string) => list.find(([v]) => v === k)?.[1] ?? k;

/** What the business owns, when each thing needs servicing or renewing, and what its upkeep has cost. */
export function Assets() {
  const app = useApp();
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [due, setDue] = useState<ComplianceItem[]>([]);
  const [showRetired, setShowRetired] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const load = useCallback(async () => {
    const [list, cal] = await Promise.all([
      api.get<Asset[]>(c(`/assets${showRetired ? '?all=1' : ''}`)),
      api.get<{ items: ComplianceItem[] }>(c(`/compliance?from=${addDays(app.status.today, -365)}&to=${addDays(app.status.today, 120)}`)),
    ]);
    setAssets(list);
    setDue(cal.items.filter((i) => i.kind === 'ASSET' && i.status !== 'DONE'));
  }, [showRetired, app.status.today]);
  useEffect(() => { void load(); }, [load, app.dataVersion]);
  const changed = async () => { await load(); app.bumpData(); };
  const soon = due.filter((d) => d.status === 'OVERDUE' || d.status === 'DUE_SOON');

  return (
    <div>
      <ScreenHead title="Assets and upkeep" sub="Service, AMC, insurance and warranty dates remind you in the bell; repairs can be posted as expenses.">
        <label className="check small"><input type="checkbox" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} /> Show retired</label>
        <button className="primary" onClick={() => setAdding(true)}>Add asset</button>
      </ScreenHead>
      {soon.length > 0 && (
        <div className="due-box">
          <h2>Upkeep due</h2>
          <ul>{soon.map((d) => (
            <li key={d.key} className={d.status === 'OVERDUE' ? 'bad' : ''}><strong>{d.title}</strong><span className="due-when">{dueText(d)} · {fmtDate(d.due)}</span></li>
          ))}</ul>
        </div>
      )}
      {!assets ? <p className="muted">Loading…</p> : assets.length === 0 ? <Empty>No assets yet. Add machines, vehicles, computers or premises to track their servicing and renewals.</Empty> : (
        <table className="list selectable">
          <thead><tr><th>Asset</th><th>Category</th><th>Location</th><th>Bought</th><th className="num">Cost ₹</th><th>Next upkeep</th><th className="num">Upkeep spent ₹</th></tr></thead>
          <tbody>{assets.map((a) => (
            <tr key={a.id} tabIndex={0} className={a.active ? '' : 'switched-off'} onClick={() => setOpenId(a.id)} onKeyDown={(e) => { if (e.key === 'Enter') setOpenId(a.id); }}>
              <td>{a.name}{!a.active && <small className="tag">retired</small>}{a.serialNo && <div className="muted small">S/N {a.serialNo}</div>}</td>
              <td>{a.category}</td><td>{a.location}</td><td>{a.purchaseDate ? fmtDate(a.purchaseDate) : ''}</td>
              <td className="num">{a.costMinor ? inr(a.costMinor) : ''}</td><td>{a.nextDue ? fmtDate(a.nextDue) : <span className="muted">none set</span>}</td>
              <td className="num">{inr(a.upkeepMinor, { blankZero: true })}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
      {adding && <AssetForm onClose={() => setAdding(false)} onSaved={async () => { setAdding(false); await changed(); }} />}
      {openId && <AssetDetail id={openId} due={due.filter((d) => d.taskId && d.key.startsWith('ASSET:'))} onClose={() => setOpenId(null)} onChanged={changed} />}
    </div>
  );
}

function AssetForm({ asset, onClose, onSaved }: { asset?: Asset; onClose: () => void; onSaved: () => Promise<void> }) {
  const app = useApp();
  const [f, setF] = useState({
    name: asset?.name ?? '', category: asset?.category ?? '', location: asset?.location ?? '', serialNo: asset?.serialNo ?? '',
    purchaseDate: asset?.purchaseDate ?? '', cost: asset?.costMinor ? (Number(asset.costMinor) / 100).toFixed(2) : '', ledgerId: asset?.ledgerId ?? '', notes: asset?.notes ?? '',
  });
  const [err, setErr] = useState<Err>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const fixed = app.masters.ledgers.filter((l) => l.path.includes('fixed_assets'));
  const save = async () => {
    try {
      const body = { ...f, ledgerId: f.ledgerId || null, purchaseDate: f.purchaseDate || null, cost: f.cost || null };
      if (asset) await api.patch(c(`/assets/${asset.id}`), body); else await api.post(c('/assets'), body);
      app.toast(asset ? 'Asset saved' : `${f.name} added`); await onSaved();
    } catch (e) { setErr(asErr(e)); }
  };
  return (
    <Modal title={asset ? `Edit ${asset.name}` : 'Add an asset'} onClose={onClose}>
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <label>Name<input value={f.name} onChange={set('name')} required placeholder="e.g. Diesel generator 15 kVA" /></label>
        <label>Category<input value={f.category} onChange={set('category')} placeholder="Plant, Vehicle, Computer, Premises…" /></label>
        <label>Location<input value={f.location} onChange={set('location')} /></label>
        <label>Serial / registration no.<input value={f.serialNo} onChange={set('serialNo')} /></label>
        <label>Bought on<input type="date" value={f.purchaseDate} onChange={set('purchaseDate')} /></label>
        <label>Cost (₹)<input value={f.cost} onChange={set('cost')} inputMode="decimal" /></label>
        <label className="span-2">Booked in ledger<select value={f.ledgerId} onChange={set('ledgerId')}><option value="">—</option>{fixed.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
        <label className="span-2">Notes<input value={f.notes} onChange={set('notes')} /></label>
        <ErrorBox error={err} />
        <div className="form-actions"><button className="primary" type="submit">Save</button></div>
      </form>
    </Modal>
  );
}

function AssetDetail({ id, due, onClose, onChanged }: { id: string; due: ComplianceItem[]; onClose: () => void; onChanged: () => Promise<void> }) {
  const app = useApp();
  const [d, setD] = useState<{ asset: Asset; schedules: Schedule[]; logs: Log[] } | null>(null);
  const [mode, setMode] = useState<null | 'edit' | 'schedule' | { log: string | null }>(null);
  const [err, setErr] = useState<Err>(null);
  const load = useCallback(async () => { try { setD(await api.get(c(`/assets/${id}`))); } catch (e) { setErr(asErr(e)); } }, [id]);
  useEffect(() => { void load(); }, [load]);
  const changed = async () => { setMode(null); await load(); await onChanged(); };
  if (!d) return <Modal title="Asset" onClose={onClose}><ErrorBox error={err} />{!err && <p className="muted">Loading…</p>}</Modal>;
  const a = d.asset;
  const mine = due.filter((x) => d.schedules.some((s) => s.id === x.taskId));
  const stop = async (s: Schedule) => {
    if (!window.confirm(`Stop the reminder "${s.title}"?`)) return;
    try { await api.delete(c(`/asset-schedules/${s.id}`)); await changed(); } catch (e) { setErr(asErr(e)); }
  };
  const retire = async () => {
    if (!window.confirm(`Mark ${a.name} as retired (sold, scrapped)? Its reminders stop; its history stays.`)) return;
    try { await api.patch(c(`/assets/${a.id}`), { active: false }); app.toast(`${a.name} retired`); await onChanged(); onClose(); } catch (e) { setErr(asErr(e)); }
  };
  return (
    <Modal title={a.name} onClose={onClose} wide>
      <p className="muted small">{[a.category, a.location, a.serialNo && `S/N ${a.serialNo}`, a.purchaseDate && `bought ${fmtDate(a.purchaseDate)}`, a.costMinor && `₹${inr(a.costMinor)}`, a.ledgerName].filter(Boolean).join(' · ')}</p>
      {a.notes && <p className="small">{a.notes}</p>}
      <div className="head-actions">
        <button className="primary" onClick={() => setMode({ log: null })}>Log repair / service</button>
        {a.active && <button onClick={() => setMode('schedule')}>Add reminder</button>}
        <button onClick={() => setMode('edit')}>Edit details</button>
        {a.active && <button className="danger" onClick={() => void retire()}>Retire</button>}
      </div>
      <ErrorBox error={err} />
      {mode === 'edit' && <AssetForm asset={a} onClose={() => setMode(null)} onSaved={changed} />}
      {mode === 'schedule' && <ScheduleForm assetId={a.id} onDone={changed} onCancel={() => setMode(null)} />}
      {mode && typeof mode === 'object' && <LogForm assetId={a.id} scheduleKey={mode.log} title={mine.find((m) => m.key === mode.log)?.title} onDone={changed} onCancel={() => setMode(null)} />}

      <h3>Upcoming upkeep</h3>
      {mine.length === 0 && d.schedules.length === 0 ? <p className="muted small">No reminders. Add service, AMC, insurance or warranty dates.</p> : (
        <table className="list">
          <thead><tr><th>Due</th><th>What</th><th>Repeats</th><th>Status</th><th /></tr></thead>
          <tbody>
            {mine.map((m) => (
              <tr key={m.key}><td>{fmtDate(m.due)}</td><td>{m.title.replace(`${a.name} — `, '')}</td><td>{m.periodLabel}</td>
                <td className={m.status === 'OVERDUE' ? 'bad' : ''}>{dueText(m)}</td>
                <td><button onClick={() => setMode({ log: m.key })}>Done…</button></td></tr>
            ))}
          </tbody>
        </table>
      )}
      {d.schedules.length > 0 && (
        <p className="small">Reminders: {d.schedules.map((s) => (
          <span key={s.id} className="pill">{s.title} · {label(REPEATS, s.repeat).toLowerCase()} from {fmtDate(s.nextDue)}{s.vendor ? ` · ${s.vendor}` : ''} <button className="link" onClick={() => void stop(s)}>stop</button></span>
        ))}</p>
      )}

      <h3>Upkeep log</h3>
      {d.logs.length === 0 ? <p className="muted small">Nothing logged yet.</p> : (
        <table className="list">
          <thead><tr><th>Date</th><th>Type</th><th>What was done</th><th>By</th><th className="num">Cost ₹</th><th>Voucher</th></tr></thead>
          <tbody>{d.logs.map((g) => (
            <tr key={g.id}><td>{fmtDate(g.date)}</td><td>{label(LOG_KINDS, g.kind)}</td><td>{g.description}</td><td>{g.vendor}</td>
              <td className="num">{g.costMinor ? inr(g.costMinor) : ''}</td>
              <td>{g.voucherId ? <button className="link" onClick={() => app.go({ screen: 'voucher-view', params: { id: g.voucherId } })}>{g.voucherNo}</button> : ''}</td></tr>
          ))}</tbody>
        </table>
      )}
    </Modal>
  );
}

function ScheduleForm({ assetId, onDone, onCancel }: { assetId: string; onDone: () => Promise<void>; onCancel: () => void }) {
  const app = useApp();
  const [f, setF] = useState({ kind: 'SERVICE', title: '', nextDue: addDays(app.status.today, 30), repeat: 'YEARLY', remindDays: '15', vendor: '', notes: '' });
  const [err, setErr] = useState<Err>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    try { await api.post(c(`/assets/${assetId}/schedules`), { ...f, title: f.title || null, remindDays: Number(f.remindDays) }); app.toast('Reminder added'); await onDone(); } catch (e) { setErr(asErr(e)); }
  };
  return (
    <form className="inline-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <label>What<select value={f.kind} onChange={set('kind')}>{KINDS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <label className="grow">Title (optional)<input value={f.title} onChange={set('title')} placeholder={label(KINDS, f.kind)} /></label>
      <label>Next due<input type="date" value={f.nextDue} onChange={set('nextDue')} required /></label>
      <label>Repeats<select value={f.repeat} onChange={set('repeat')}>{REPEATS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <label>Remind days before<input type="number" min={0} max={90} value={f.remindDays} onChange={set('remindDays')} /></label>
      <label>Vendor<input value={f.vendor} onChange={set('vendor')} /></label>
      <button className="primary" type="submit">Add</button><button type="button" onClick={onCancel}>Cancel</button>
      <ErrorBox error={err} />
    </form>
  );
}

function LogForm({ assetId, scheduleKey, title, onDone, onCancel }: { assetId: string; scheduleKey: string | null; title?: string; onDone: () => Promise<void>; onCancel: () => void }) {
  const app = useApp();
  const [f, setF] = useState({
    date: app.status.today, kind: scheduleKey ? 'SERVICE' : 'REPAIR', description: title ? `${title.split(' — ').pop()} done` : '', cost: '', vendor: '',
    paidFromLedgerId: '', expenseLedgerId: null as string | null, gstRate: '18', billNo: '',
  });
  const [key] = useState(uid);
  const [warnings, setWarnings] = useState<string[] | null>(null);
  const [err, setErr] = useState<Err>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const heads: Option[] = useMemo(() => app.masters.ledgers
    .filter((l) => !l.taxComponent && !l.isCashBank && !l.counterpartyId && (l.nature === 'EXPENSE' || l.path.includes('fixed_assets')))
    .map((l) => ({ id: l.id, label: l.name, sub: l.groupName })), [app.masters.ledgers]);
  const save = async () => {
    try {
      await api.post(c(`/assets/${assetId}/logs`), {
        ...f, cost: f.cost || null, paidFromLedgerId: f.paidFromLedgerId || null, scheduleKey, confirmWarnings: warnings !== null,
        gstRate: f.paidFromLedgerId ? f.gstRate : null,
      }, { 'Idempotency-Key': key });
      app.toast(f.paidFromLedgerId ? 'Logged and posted' : 'Logged'); await onDone();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CONFIRM_WARNINGS') setWarnings((e.details as { warnings: { message: string }[] }).warnings.map((w) => w.message));
      else setErr(asErr(e));
    }
  };
  return (
    <form className="form-grid log-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      {title && <p className="span-2"><strong>Completes:</strong> {title}</p>}
      <label>Date<input type="date" value={f.date} max={app.status.today} onChange={set('date')} required /></label>
      <label>Type<select value={f.kind} onChange={set('kind')}>{LOG_KINDS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <label className="span-2">What was done<input value={f.description} onChange={set('description')} required /></label>
      <label>Done by (vendor)<input value={f.vendor} onChange={set('vendor')} /></label>
      <label>Cost (₹, bill total)<input value={f.cost} onChange={set('cost')} inputMode="decimal" /></label>
      <label>Post the cost, paid from
        <select value={f.paidFromLedgerId} onChange={set('paidFromLedgerId')}>
          <option value="">Don't post (already in the books, or no cost)</option>
          {app.masters.ledgers.filter((l) => l.isCashBank).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </label>
      {f.paidFromLedgerId && <>
        <label>Expense head<Picker options={heads} value={f.expenseLedgerId} onChange={(id) => setF({ ...f, expenseLedgerId: id })} placeholder="Repairs & Maintenance" ariaLabel="Expense head" /></label>
        <label>GST on the bill<select value={f.gstRate} onChange={set('gstRate')}><option value="0">No GST</option>{['5', '12', '18', '28'].map((r) => <option key={r} value={r}>{r}% included</option>)}</select></label>
        <label>Bill no.<input value={f.billNo} onChange={set('billNo')} maxLength={16} /></label>
      </>}
      {warnings && <div className="warn span-2">{warnings.map((w) => <p key={w} className="small">{w}</p>)}</div>}
      <ErrorBox error={err} />
      <div className="form-actions"><button type="button" onClick={onCancel}>Cancel</button><button className="primary" type="submit">{warnings ? 'Save anyway' : 'Save'}</button></div>
    </form>
  );
}
