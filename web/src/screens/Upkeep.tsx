import { useCallback, useEffect, useState } from 'react';
import { api, c, ApiError } from '../api';
import { useApp } from '../state';
import { ErrorBox, ScreenHead } from '../components/ui';
import { fmtDate, fyStart, inr } from '../format';
import { Backups } from './Masters';

interface Check { id: string; label: string; level: 'ok' | 'warn' | 'error' | 'info'; detail: string; fix?: string }
interface OldDoc { id: string; fileName: string; status: string; createdAt: string }
interface ClosePreview { start: string; end: string; blockers: string[]; warnings: string[]; alreadyLocked: boolean; netProfitMinor: string; closingStockMinor: string }
type Err = { message: string; details?: unknown } | null;
const asErr = (e: unknown): Err => (e instanceof ApiError ? { message: e.message, details: e.details } : { message: String(e) });
const ICON: Record<Check['level'], string> = { ok: '✓', info: 'i', warn: '!', error: '✕' };

/** Housekeeping: is everything in order, backups, clearing old uploads, closing a finished year. */
export function Upkeep() {
  return (
    <div className="settings upkeep">
      <ScreenHead title="Upkeep" sub="Keep the books healthy: check them, back them up, tidy old uploads and close finished years." />
      <Health />
      <Backups />
      <OldDocuments />
      <YearClose />
    </div>
  );
}

function Health() {
  const app = useApp();
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [err, setErr] = useState<Err>(null);
  const run = useCallback(async () => {
    setChecks(null);
    try { setChecks(await api.get<Check[]>(c('/upkeep/health'))); setErr(null); } catch (e) { setErr(asErr(e)); }
  }, []);
  useEffect(() => { void run(); }, [run, app.dataVersion]);
  return (
    <>
      <h3>Health check <button className="link" onClick={() => void run()}>Run again</button></h3>
      <ErrorBox error={err} />
      {!checks ? <p className="muted">Checking the books…</p> : (
        <ul className="checks">
          {checks.map((k) => (
            <li key={k.id} className={`check-${k.level}`}>
              <span className="check-icon" aria-label={k.level}>{ICON[k.level]}</span>
              <div><strong>{k.label}</strong> <span>{k.detail}</span>{k.fix && <div className="muted small">{k.fix}</div>}</div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function OldDocuments() {
  const app = useApp();
  const [docs, setDocs] = useState<OldDoc[] | null>(null);
  const [err, setErr] = useState<Err>(null);
  const load = useCallback(() => api.get<OldDoc[]>(c('/upkeep/old-documents?days=90')).then(setDocs).catch((e) => setErr(asErr(e))), []);
  useEffect(() => { void load(); }, [load, app.dataVersion]);
  const clear = async () => {
    if (!docs?.length || !window.confirm(`Delete ${docs.length} old upload(s) and their files? Nothing from them is in the books.`)) return;
    try {
      const r = await api.post<{ deleted: number }>(c('/upkeep/old-documents/delete'), { ids: docs.map((d) => d.id) });
      app.toast(`Deleted ${r.deleted} old upload(s)`); await load();
    } catch (e) { setErr(asErr(e)); }
  };
  return (
    <>
      <h3>Old uploads</h3>
      <ErrorBox error={err} />
      {docs && (docs.length === 0
        ? <p className="muted small">Nothing to clear: no rejected or unreadable uploads older than 90 days.</p>
        : <>
          <p className="small">{docs.length} rejected or unreadable upload(s) older than 90 days, with nothing from them in the books:</p>
          <ul className="small">{docs.slice(0, 10).map((d) => <li key={d.id}>{d.fileName} <span className="muted">({d.status.toLowerCase()}, {fmtDate(d.createdAt)})</span></li>)}</ul>
          {docs.length > 10 && <p className="muted small">and {docs.length - 10} more</p>}
          <button className="danger" onClick={() => void clear()}>Delete them</button>
        </>)}
    </>
  );
}

function YearClose() {
  const app = useApp();
  // The last financial year that has ended.
  const lastEnd = (() => { const d = new Date(`${fyStart(app.status.today, app.company.fyStartMonth)}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); })();
  const [end, setEnd] = useState(lastEnd);
  const [p, setP] = useState<ClosePreview | null>(null);
  const [err, setErr] = useState<Err>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    setP(null);
    api.get<ClosePreview>(c(`/upkeep/year-close?end=${end}`)).then((x) => { if (live) { setP(x); setErr(null); } }).catch((e) => { if (live) setErr(asErr(e)); });
    return () => { live = false; };
  }, [end, app.dataVersion]);
  const close = async () => {
    if (!p || !window.confirm(`Close the year ${fmtDate(p.start)} to ${fmtDate(p.end)}? Nothing more can be posted on or before ${fmtDate(p.end)} unless the lock date is changed in Settings.`)) return;
    setBusy(true);
    try { await api.post(c('/upkeep/year-close'), { end }); await app.refreshCompany(); app.bumpData(); app.toast(`Year to ${fmtDate(end)} closed`); }
    catch (e) { setErr(asErr(e)); } finally { setBusy(false); }
  };
  const years = [0, 1, 2].map((n) => `${Number(lastEnd.slice(0, 4)) - n}${lastEnd.slice(4)}`);
  return (
    <>
      <h3>Close a financial year</h3>
      <p className="small">Closing locks the year so nothing more can be posted into it. The profit carries into the next year and closing stock
        becomes its opening stock by themselves; nothing has to be posted. Close a year once its accounts and returns are final.</p>
      <label className="inline-form">Year ending<select value={end} onChange={(e) => setEnd(e.target.value)}>{years.map((y) => <option key={y} value={y}>{fmtDate(y)}</option>)}</select></label>
      <ErrorBox error={err} />
      {p && (
        <div className="year-close">
          <p>{fmtDate(p.start)} to {fmtDate(p.end)}: {BigInt(p.netProfitMinor) >= 0n ? 'profit' : 'loss'} ₹{inr(p.netProfitMinor, { abs: true })}, closing stock ₹{inr(p.closingStockMinor)}.</p>
          {p.blockers.length > 0 && <div className="error-box"><strong>Finish these first:</strong><ul>{p.blockers.map((b) => <li key={b}>{b}</li>)}</ul></div>}
          {p.warnings.length > 0 && <div className="warn small"><ul>{p.warnings.map((w) => <li key={w}>{w}</li>)}</ul></div>}
          {p.alreadyLocked
            ? <p className="ok">This year is already closed.</p>
            : <button className="primary" disabled={busy || p.blockers.length > 0} onClick={() => void close()}>Close the year</button>}
        </div>
      )}
    </>
  );
}
