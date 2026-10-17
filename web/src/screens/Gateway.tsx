import { useEffect, useState } from 'react';
import { api, c, type ComplianceAlerts } from '../api';
import { dueText } from '../notify';
import { useApp, type Route } from '../state';
import { useKeys, isTyping } from '../keys';
import { Kbd } from '../components/ui';
import { fmtDate, inr, TYPE_LABEL } from '../format';

interface Dash {
  today: string; cashMinor: string; bankMinor: string; receivablesMinor: string; receivablesOver60Minor: string;
  payablesMinor: string; salesTodayMinor: string; salesMonthMinor: string; purchasesMonthMinor: string;
  gstPayableMonthMinor: string; pendingDocuments: number;
  recent: { id: string; voucherNo: string; date: string; voucherType: string; totalMinor: string; source: string; party: string | null }[];
}

export const MENU: { key: string; label: string; route: Route; group: string }[] = [
  { key: 'V', label: 'Vouchers (enter)', route: { screen: 'voucher', params: { type: 'SALES' } }, group: 'Transactions' },
  { key: 'D', label: 'Day Book', route: { screen: 'daybook' }, group: 'Transactions' },
  { key: 'R', label: 'Documents (bills, statements, workings)', route: { screen: 'review' }, group: 'Transactions' },
  { key: 'M', label: 'Masters', route: { screen: 'masters' }, group: 'Masters' },
  { key: 'T', label: 'Trial Balance', route: { screen: 'tb' }, group: 'Reports' },
  { key: 'P', label: 'Profit & Loss', route: { screen: 'pl' }, group: 'Reports' },
  { key: 'B', label: 'Balance Sheet', route: { screen: 'bs' }, group: 'Reports' },
  { key: 'A', label: 'Ageing (receivables)', route: { screen: 'ageing', params: { side: 'receivable' } }, group: 'Reports' },
  { key: 'Y', label: 'Ageing (payables)', route: { screen: 'ageing', params: { side: 'payable' } }, group: 'Reports' },
  { key: 'L', label: 'Ledger statement', route: { screen: 'ledger' }, group: 'Reports' },
  { key: 'S', label: 'Stock Summary', route: { screen: 'stock' }, group: 'Reports' },
  { key: 'G', label: 'GST Summary', route: { screen: 'gst' }, group: 'Reports' },
  { key: 'C', label: 'Compliance calendar (GST, TDS, income tax, reminders)', route: { screen: 'compliance' }, group: 'Company' },
  { key: 'O', label: 'Settings', route: { screen: 'settings' }, group: 'Company' },
];

export function Gateway() {
  const app = useApp();
  const [d, setD] = useState<Dash | null>(null);
  const [due, setDue] = useState<ComplianceAlerts | null>(null);
  useEffect(() => { void api.get<Dash>(c('/dashboard')).then(setD); }, [app.dataVersion]);
  useEffect(() => { void api.get<ComplianceAlerts>(c('/compliance/alerts')).then(setDue).catch(() => {}); }, [app.dataVersion]);

  const keys: Record<string, (e: KeyboardEvent) => boolean | void> = {};
  for (const m of MENU) keys[m.key] = (e) => { if (isTyping(e)) return false; app.go(m.route); };
  useKeys(keys);

  const tile = (label: string, v: string | undefined, note?: string, onClick?: () => void) => (
    <button className="tile" onClick={onClick} disabled={!onClick}>
      <span className="tile-label">{label}</span>
      <span className="tile-value num">₹{v ? inr(v) : '—'}</span>
      {note && <span className="tile-note">{note}</span>}
    </button>
  );

  return (
    <div className="gateway">
      <section className="tiles" aria-label="Key figures">
        {tile('Cash in hand', d?.cashMinor, undefined, () => app.go({ screen: 'ledger', params: { ledgerId: app.masters.ledgers.find((l) => l.systemCode === 'CASH')?.id } }))}
        {tile('Bank balance', d?.bankMinor, undefined, () => app.go({ screen: 'ledger', params: { ledgerId: app.masters.ledgers.find((l) => l.isCashBank && l.systemCode !== 'CASH')?.id } }))}
        {tile('Receivables', d?.receivablesMinor, d ? `₹${inr(d.receivablesOver60Minor)} over 60 days` : undefined, () => app.go({ screen: 'ageing', params: { side: 'receivable' } }))}
        {tile('Payables', d?.payablesMinor, undefined, () => app.go({ screen: 'ageing', params: { side: 'payable' } }))}
        {tile('Sales this month', d?.salesMonthMinor, d ? `today ₹${inr(d.salesTodayMinor)}` : undefined, () => app.go({ screen: 'daybook', params: { type: 'SALES', from: `${app.status.today.slice(0, 8)}01` } }))}
        {tile('GST payable (month)', d?.gstPayableMonthMinor, 'output − input credit', () => app.go({ screen: 'gst' }))}
      </section>

      <div className="gateway-cols">
        <nav className="menu" aria-label="Gateway">
          <h2>Gateway of Kannaku AI</h2>
          {['Transactions', 'Masters', 'Reports', 'Company'].map((g) => (
            <div key={g} className="menu-group">
              <h3>{g}</h3>
              {MENU.filter((m) => m.group === g).map((m) => (
                <button key={m.key} className="menu-item" onClick={() => app.go(m.route)}>
                  <Kbd>{m.key}</Kbd> {m.label}
                  {m.key === 'R' && d && d.pendingDocuments > 0 && <span className="badge">{d.pendingDocuments}</span>}
                </button>
              ))}
            </div>
          ))}
        </nav>

        <section className="recent">
          {due && due.items.length > 0 && (
            <div className="due-box">
              <h2>Due soon <button className="link" onClick={() => app.go({ screen: 'compliance' })}>Compliance calendar <Kbd>C</Kbd></button></h2>
              <ul>
                {due.items.slice(0, 4).map((i) => (
                  <li key={i.key} className={i.status === 'OVERDUE' ? 'bad' : ''}>
                    <strong>{i.title}</strong> <span className="muted">{i.periodLabel}</span>
                    <span className="due-when">{dueText(i)} · {fmtDate(i.due)}{i.estimateMinor && BigInt(i.estimateMinor) > 0n ? ` · ₹${inr(i.estimateMinor)}` : ''}</span>
                  </li>
                ))}
              </ul>
              {due.items.length > 4 && <p className="muted small">and {due.items.length - 4} more</p>}
            </div>
          )}
          <h2>Recent vouchers</h2>
          {d && d.recent.length === 0 && (
            <div className="empty-state">No entries yet. Press <Kbd>F8</Kbd> to record your first sale, <Kbd>M</Kbd> to add parties and items, or <Kbd>Ctrl+U</Kbd> to upload a bill, bank statement or workings.</div>
          )}
          {(!d || d.recent.length > 0) && <table className="list">
            <thead><tr><th>Date</th><th>Type</th><th>No.</th><th>Particulars</th><th className="num">Amount</th><th>Via</th></tr></thead>
            <tbody>
              {d?.recent.map((v) => (
                <tr key={v.id} tabIndex={0} onClick={() => app.go({ screen: 'voucher-view', params: { id: v.id } })}
                  onKeyDown={(e) => { if (e.key === 'Enter') app.go({ screen: 'voucher-view', params: { id: v.id } }); }}>
                  <td>{fmtDate(v.date)}</td><td>{TYPE_LABEL[v.voucherType]}</td><td>{v.voucherNo}</td><td>{v.party ?? '—'}</td>
                  <td className="num">{inr(v.totalMinor)}</td><td><span className={`src src-${v.source.toLowerCase()}`}>{v.source.toLowerCase()}</span></td>
                </tr>
              ))}
            </tbody>
          </table>}
          <div className="quick">
            <h3>Quick entry</h3>
            <p><Kbd>F8</Kbd> Sales <Kbd>F9</Kbd> Purchase <Kbd>F5</Kbd> Payment <Kbd>F6</Kbd> Receipt <Kbd>F4</Kbd> Contra <Kbd>F7</Kbd> Journal</p>
            <p><Kbd>Ctrl+U</Kbd> Upload bills, statements, workings · hold <Kbd>Ctrl+Space</Kbd> to speak · <Kbd>Ctrl+K</Kbd> Go to anything</p>
          </div>
        </section>
      </div>
    </div>
  );
}
