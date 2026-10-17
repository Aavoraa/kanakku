import { useCallback, useEffect, useRef, useState } from 'react';
import { api, c, type ComplianceAlerts } from '../api';
import { useApp, type Screen } from '../state';
import { fmtDate } from '../format';
import { dueText, notifyDue } from '../notify';

/** Top-bar bell: GST, TDS and income-tax filings and own reminders that are overdue or due soon. */
export function AlertsBell() {
  const app = useApp();
  const [data, setData] = useState<ComplianceAlerts | null>(null);
  const [open, setOpen] = useState(false);
  const companyId = app.company.id;
  const companyName = app.company.name;
  // app.go changes on every navigation; reading it through a ref keeps the bell from reloading each time.
  const goRef = useRef(app.go);
  goRef.current = app.go;

  const load = useCallback(async () => {
    try {
      const a = await api.get<ComplianceAlerts>(c('/compliance/alerts'));
      setData(a);
      notifyDue(a.items, companyName, a.today, () => goRef.current({ screen: 'compliance' }));
    } catch { /* the bell just stays as it was */ }
    // companyId: reload for the other company after a switch.
  }, [companyId, companyName]); // eslint-disable-line react-hooks/exhaustive-deps

  // On open, when the books or the calendar change, when the window comes back, and every 15 minutes.
  useEffect(() => { void load(); }, [load, app.dataVersion]);
  useEffect(() => {
    const t = setInterval(() => void load(), 15 * 60_000);
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(t); window.removeEventListener('focus', onFocus); };
  }, [load]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest('.alerts')) setOpen(false); };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  const count = data ? data.overdue + data.dueSoon : 0;
  const label = !data ? 'Compliance reminders' : count === 0 ? 'Nothing due soon'
    : `${data.overdue ? `${data.overdue} overdue` : ''}${data.overdue && data.dueSoon ? ', ' : ''}${data.dueSoon ? `${data.dueSoon} due soon` : ''}`;
  return (
    <div className="alerts">
      <button className={`bell ${data?.overdue ? 'has-overdue' : ''}`} onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}
        aria-label={`Compliance reminders: ${label}`} title={label}>
        <span aria-hidden>🔔</span>{count > 0 && <span className="bell-count">{count > 99 ? '99+' : count}</span>}
      </button>
      {open && (
        <div className="menu-pop right alerts-pop" role="menu">
          <div className="menu-who"><strong>Compliance</strong><small>{label}</small></div>
          <hr />
          {data?.items.slice(0, 8).map((i) => (
            <button key={i.key} role="menuitem" onClick={() => { setOpen(false); app.go({ screen: (i.link ?? 'compliance') as Screen }); }}>
              <span>{i.title} <span className="muted">· {i.periodLabel}</span></span>
              <small className={i.status === 'OVERDUE' ? 'bad' : ''}>{dueText(i)} · {fmtDate(i.due)}</small>
            </button>
          ))}
          {data && data.items.length > 8 && <small className="muted alerts-more">and {data.items.length - 8} more</small>}
          {data?.items.length === 0 && <small className="muted alerts-more">You are up to date.</small>}
          <hr />
          <button role="menuitem" onClick={() => { setOpen(false); app.go({ screen: 'compliance' }); }}>Open compliance calendar <small>Gateway key C</small></button>
        </div>
      )}
    </div>
  );
}
