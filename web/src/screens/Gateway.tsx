import { useEffect, useState } from 'react';
import { api, c, type ComplianceAlerts } from '../api';
import { useApp, type Screen } from '../state';
import { useKeys, isTyping } from '../keys';
import { Kbd } from '../components/ui';
import { Icon, type IconName } from '../components/Icon';
import { TradeChart, type MonthPoint } from '../components/TradeChart';
import { dueText } from '../notify';
import { LETTER_KEYS, NAV } from '../nav';
import { fmtDate, inr, TYPE_LABEL } from '../format';

interface Dash {
  today: string; cashMinor: string; bankMinor: string; receivablesMinor: string; receivablesOver60Minor: string;
  payablesMinor: string; salesTodayMinor: string; salesMonthMinor: string; purchasesMonthMinor: string;
  gstPayableMonthMinor: string; pendingDocuments: number; months: MonthPoint[];
  recent: { id: string; voucherNo: string; date: string; voucherType: string; totalMinor: string; source: string; party: string | null }[];
}

/** Kept for anything that still lists pages by group (the sidebar and palette read nav.ts). */
export const MENU = NAV.flatMap((g) => g.items.filter((i) => i.key && /^[A-Z]$/.test(i.key)).map((i) => ({ key: i.key!, label: i.label, route: i.route, group: g.title ?? '' })));

const greeting = () => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; };

/** Home: the day's position at a glance, what is due, the trend, and recent entries. */
export function Gateway() {
  const app = useApp();
  const [d, setD] = useState<Dash | null>(null);
  const [due, setDue] = useState<ComplianceAlerts | null>(null);
  useEffect(() => { void api.get<Dash>(c('/dashboard')).then(setD).catch(() => {}); }, [app.dataVersion]);
  useEffect(() => { void api.get<ComplianceAlerts>(c('/compliance/alerts')).then(setDue).catch(() => {}); }, [app.dataVersion]);

  // Single letters open pages, as on the old Gateway (D Day Book, T Trial Balance, ...).
  const keys: Record<string, (e: KeyboardEvent) => boolean | void> = {};
  for (const m of LETTER_KEYS) keys[m.key!] = (e) => { if (isTyping(e)) return false; app.go(m.route); };
  useKeys(keys);

  const firstName = app.user.name.trim().split(/\s+/)[0];
  const kpi = (label: string, icon: IconName, v: string | undefined, note: string | null, onClick?: () => void, tone?: 'attention') => (
    <button className={`kpi ${tone ?? ''}`} onClick={onClick} disabled={!onClick}>
      <span className="kpi-top"><span className="kpi-icon"><Icon name={icon} size={17} /></span><span className="kpi-label">{label}</span></span>
      <span className="kpi-value num">{v === undefined ? <span className="skeleton" /> : `₹${inr(v)}`}</span>
      {note && <span className="kpi-note">{note}</span>}
    </button>
  );
  const ledgerOf = (pred: (l: (typeof app.masters.ledgers)[number]) => boolean) => app.masters.ledgers.find(pred)?.id;

  return (
    <div className="home">
      <div className="home-head">
        <div>
          <h1>{greeting()}, {firstName}</h1>
          <p className="muted">{app.company.name} · {fmtDate(app.status.today)}</p>
        </div>
        <div className="quick-actions">
          <button className="primary" onClick={() => app.go({ screen: 'voucher', params: { type: 'SALES' } })}><Icon name="plus" size={16} /> New sale <Kbd>F8</Kbd></button>
          <button onClick={() => app.go({ screen: 'voucher', params: { type: 'PURCHASE' } })}>Purchase <Kbd>F9</Kbd></button>
          <button onClick={() => app.go({ screen: 'voucher', params: { type: 'RECEIPT' } })}>Receipt <Kbd>F6</Kbd></button>
          <button onClick={() => app.go({ screen: 'voucher', params: { type: 'PAYMENT' } })}>Payment <Kbd>F5</Kbd></button>
          <button onClick={() => app.go({ screen: 'review', params: { upload: true } })}><Icon name="upload" size={16} /> Upload <Kbd>Ctrl+U</Kbd></button>
        </div>
      </div>

      <section className="kpis" aria-label="Key figures">
        {kpi('Cash in hand', 'cash', d?.cashMinor, null, () => app.go({ screen: 'ledger', params: { ledgerId: ledgerOf((l) => l.systemCode === 'CASH') } }))}
        {kpi('Bank balance', 'bank', d?.bankMinor, null, () => app.go({ screen: 'ledger', params: { ledgerId: ledgerOf((l) => l.isCashBank && l.systemCode !== 'CASH') } }))}
        {kpi('Receivables', 'arrowIn', d?.receivablesMinor, d ? `₹${inr(d.receivablesOver60Minor)} over 60 days` : null, () => app.go({ screen: 'ageing', params: { side: 'receivable' } }),
          d && BigInt(d.receivablesOver60Minor) > 0n ? 'attention' : undefined)}
        {kpi('Payables', 'arrowOut', d?.payablesMinor, null, () => app.go({ screen: 'ageing', params: { side: 'payable' } }))}
        {kpi('Sales this month', 'sales', d?.salesMonthMinor, d ? `Today ₹${inr(d.salesTodayMinor)}` : null, () => app.go({ screen: 'daybook', params: { type: 'SALES', from: `${app.status.today.slice(0, 8)}01` } }))}
        {kpi('GST payable (month)', 'percent', d?.gstPayableMonthMinor, 'Cash, after input credit', () => app.go({ screen: 'gst' }))}
      </section>

      <div className="home-grid">
        <section className="card chart-card">
          <div className="card-head"><h2>Sales and purchases</h2><span className="muted small">Last six months, net of credit and debit notes</span></div>
          {d ? <TradeChart data={d.months} /> : <div className="skeleton block" />}
        </section>

        <section className="card due-card">
          <div className="card-head">
            <h2>Due soon</h2>
            <button className="link" onClick={() => app.go({ screen: 'compliance' })}>Calendar <Kbd>C</Kbd></button>
          </div>
          {!due ? <div className="skeleton block" /> : due.items.length === 0 ? (
            <p className="all-clear"><Icon name="check" /> Nothing overdue or due soon.</p>
          ) : (
            <ul className="due-list">
              {due.items.slice(0, 6).map((i) => (
                <li key={i.key} className={i.status === 'OVERDUE' ? 'overdue' : ''}>
                  <button className="due-item" onClick={() => app.go({ screen: (i.link ?? 'compliance') as Screen })}>
                    <span className="due-dot" aria-hidden />
                    <span className="due-main"><strong>{i.title}</strong><span className="muted small">{i.periodLabel}</span></span>
                    <span className="due-when"><span className={i.status === 'OVERDUE' ? 'bad' : ''}>{dueText(i)}</span>
                      <span className="muted small">{fmtDate(i.due)}{i.estimateMinor && BigInt(i.estimateMinor) > 0n ? ` · ₹${inr(i.estimateMinor)}` : ''}</span></span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {due && due.items.length > 6 && <p className="muted small">and {due.items.length - 6} more</p>}
          {d && d.pendingDocuments > 0 && (
            <button className="doc-nudge" onClick={() => app.go({ screen: 'review' })}>
              <Icon name="doc" /> {d.pendingDocuments} uploaded document{d.pendingDocuments === 1 ? '' : 's'} waiting for review
            </button>
          )}
        </section>
      </div>

      <section className="card">
        <div className="card-head">
          <h2>Recent vouchers</h2>
          <button className="link" onClick={() => app.go({ screen: 'daybook' })}>Day Book <Kbd>D</Kbd></button>
        </div>
        {d && d.recent.length === 0 ? (
          <div className="empty-state">No entries yet. Press <Kbd>F8</Kbd> to record your first sale, <Kbd>M</Kbd> to add parties and items, or <Kbd>Ctrl+U</Kbd> to upload a bill, bank statement or workings.</div>
        ) : (
          <table className="list plain">
            <thead><tr><th>Date</th><th>Type</th><th>No.</th><th>Particulars</th><th className="num">Amount ₹</th><th>Via</th></tr></thead>
            <tbody>
              {d?.recent.map((v) => (
                <tr key={v.id} tabIndex={0} onClick={() => app.go({ screen: 'voucher-view', params: { id: v.id } })}
                  onKeyDown={(e) => { if (e.key === 'Enter') app.go({ screen: 'voucher-view', params: { id: v.id } }); }}>
                  <td className="nowrap">{fmtDate(v.date)}</td><td><span className={`type-tag t-${v.voucherType.toLowerCase()}`}>{TYPE_LABEL[v.voucherType]}</span></td>
                  <td className="mono">{v.voucherNo}</td><td>{v.party ?? '—'}</td>
                  <td className="num">{inr(v.totalMinor)}</td><td><span className={`src src-${v.source.toLowerCase()}`}>{v.source.toLowerCase()}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
