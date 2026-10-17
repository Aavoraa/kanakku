import { useEffect, useMemo, useRef, useState } from 'react';
import { api, c, type TreeNode } from '../api';
import { useApp } from '../state';
import { useKeys } from '../keys';
import { Picker } from '../components/Picker';
import { Empty, Kbd, ScreenHead, Tree } from '../components/ui';
import { drcr, fmtDate, fyStart, inr, pct } from '../format';

function useReport<T>(path: string | null, deps: unknown[]) {
  const { dataVersion, toast } = useApp();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!path) return;
    // Ignore the reply to a request the user has already moved on from (changed dates, left the screen).
    let live = true;
    setError(null);
    void api.get<T>(c(path))
      .then((d) => { if (live) setData(d); })
      .catch((e) => { if (live) { setError(String(e.message)); toast(`Report failed: ${String(e.message)}`, 'error'); } });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, dataVersion, ...deps]);
  return { data, error };
}

function DateField({ label, value, onChange, hotkey }: { label: string; value: string; onChange: (v: string) => void; hotkey?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  useKeys(hotkey ? { F2: () => { ref.current?.focus(); } } : {});
  return <label><span>{label}{hotkey && <> <Kbd>F2</Kbd></>}</span><input ref={ref} type="date" value={value} onChange={(e) => onChange(e.target.value)} /></label>;
}

const openLedger = (go: ReturnType<typeof useApp>['go']) => (id: string) => go({ screen: 'ledger', params: { ledgerId: id } });

export function TrialBalance() {
  const app = useApp();
  const [asOf, setAsOf] = useState(app.status.today);
  const { data } = useReport<{ groups: TreeNode[]; totalDebitMinor: string; totalCreditMinor: string; fyStart: string }>(`/reports/trial-balance?as_of=${asOf}`, []);
  return (
    <div>
      <ScreenHead title="Trial Balance" sub={`as at ${fmtDate(asOf)} · ${app.company.name}`}><DateField label="As at" value={asOf} onChange={setAsOf} hotkey /></ScreenHead>
      {data && (
        <table className="report">
          <thead><tr><th>Particulars</th><th className="num">Debit ₹</th><th className="num">Credit ₹</th></tr></thead>
          <tbody><Tree nodes={data.groups} mode="drcr" onLedger={openLedger(app.go)} /></tbody>
          <tfoot><tr><td>Grand total</td><td className="num">{inr(data.totalDebitMinor)}</td><td className="num">{inr(data.totalCreditMinor)}</td></tr></tfoot>
        </table>
      )}
      <p className="hint-bar">Click or <Kbd>Enter</Kbd> on a ledger to drill down · stock is valued separately (see Balance Sheet)</p>
    </div>
  );
}

export function ProfitLoss() {
  const app = useApp();
  const [to, setTo] = useState(app.status.today);
  const [from, setFrom] = useState(fyStart(app.status.today, app.company.fyStartMonth));
  type PL = { tradingDebit: TreeNode[]; tradingCredit: TreeNode[]; indirectExpenses: TreeNode[]; indirectIncomes: TreeNode[]; openingStockMinor: string; closingStockMinor: string; grossProfitMinor: string; netProfitMinor: string };
  const { data } = useReport<PL>(`/reports/profit-loss?from=${from}&to=${to}`, []);
  const gp = data ? BigInt(data.grossProfitMinor) : 0n;
  const np = data ? BigInt(data.netProfitMinor) : 0n;
  const v = (name: string, amount: string): TreeNode => ({ kind: 'virtual', id: name, name, amountMinor: amount, children: [] });
  return (
    <div>
      <ScreenHead title="Profit & Loss A/c" sub={`${fmtDate(from)} to ${fmtDate(to)}`}>
        <DateField label="From" value={from} onChange={setFrom} hotkey /><DateField label="To" value={to} onChange={setTo} />
      </ScreenHead>
      {data && (
        <div className="t-account">
          <table className="report">
            <thead><tr><th>Particulars</th><th className="num">₹</th></tr></thead>
            <tbody>
              <Tree nodes={[v('Opening Stock', data.openingStockMinor), ...data.tradingDebit]} onLedger={openLedger(app.go)} />
              {gp > 0n && <tr className="tree-row total"><td>Gross Profit c/o</td><td className="num">{inr(gp)}</td></tr>}
              {gp < 0n && <tr className="tree-row total"><td>Gross Loss b/f</td><td className="num">{inr(-gp)}</td></tr>}
              <Tree nodes={data.indirectExpenses} onLedger={openLedger(app.go)} />
              {np > 0n && <tr className="tree-row total strong"><td>Net Profit</td><td className="num">{inr(np)}</td></tr>}
            </tbody>
          </table>
          <table className="report">
            <thead><tr><th>Particulars</th><th className="num">₹</th></tr></thead>
            <tbody>
              <Tree nodes={[...data.tradingCredit, v('Closing Stock', data.closingStockMinor)]} onLedger={openLedger(app.go)} />
              {gp < 0n && <tr className="tree-row total"><td>Gross Loss c/o</td><td className="num">{inr(-gp)}</td></tr>}
              {gp > 0n && <tr className="tree-row total"><td>Gross Profit b/f</td><td className="num">{inr(gp)}</td></tr>}
              <Tree nodes={data.indirectIncomes} onLedger={openLedger(app.go)} />
              {np < 0n && <tr className="tree-row total strong"><td>Net Loss</td><td className="num">{inr(-np)}</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      <p className="hint-bar">Stock is valued per item (FIFO or weighted average) as at each date; no cost-of-goods journal is posted.</p>
    </div>
  );
}

export function BalanceSheet() {
  const app = useApp();
  const [asOf, setAsOf] = useState(app.status.today);
  const { data } = useReport<{ liabilities: TreeNode[]; assets: TreeNode[]; totalAssetsMinor: string; totalLiabilitiesMinor: string; differenceMinor: string }>(`/reports/balance-sheet?as_of=${asOf}`, []);
  return (
    <div>
      <ScreenHead title="Balance Sheet" sub={`as at ${fmtDate(asOf)}`}><DateField label="As at" value={asOf} onChange={setAsOf} hotkey /></ScreenHead>
      {data && <>
        {data.differenceMinor !== '0' && <div className="error-box">Difference of ₹{inr(data.differenceMinor)} — check opening balances.</div>}
        <div className="t-account">
          <table className="report">
            <thead><tr><th>Liabilities</th><th className="num">₹</th></tr></thead>
            <tbody><Tree nodes={data.liabilities} onLedger={openLedger(app.go)} /></tbody>
            <tfoot><tr><td>Total</td><td className="num">{inr(data.totalLiabilitiesMinor)}</td></tr></tfoot>
          </table>
          <table className="report">
            <thead><tr><th>Assets</th><th className="num">₹</th></tr></thead>
            <tbody><Tree nodes={data.assets} onLedger={openLedger(app.go)} /></tbody>
            <tfoot><tr><td>Total</td><td className="num">{inr(data.totalAssetsMinor)}</td></tr></tfoot>
          </table>
        </div>
      </>}
    </div>
  );
}

interface AgeingData {
  parties: { ledgerId: string; party: string; buckets: Record<string, string>; bills: { billRef: string; billDate: string; dueDate: string | null; daysOverdue: number | null; amountMinor: string }[] }[];
  totals: Record<string, string>;
}

export function Ageing({ params }: { params?: { side?: 'receivable' | 'payable' } }) {
  const app = useApp();
  const [side, setSide] = useState<'receivable' | 'payable'>(params?.side ?? 'receivable');
  const [asOf, setAsOf] = useState(app.status.today);
  const [expanded, setExpanded] = useState<string | null>(null);
  const { data } = useReport<AgeingData>(`/reports/ageing?side=${side}&as_of=${asOf}`, []);
  const cols: [string, string][] = [['notDue', 'Not due'], ['d1_30', '1–30'], ['d31_60', '31–60'], ['d61_90', '61–90'], ['d90plus', '90+'], ['unadjusted', 'On account'], ['total', 'Total']];
  return (
    <div>
      <ScreenHead title={side === 'receivable' ? 'Receivables ageing' : 'Payables ageing'} sub={`days past due, as at ${fmtDate(asOf)}`}>
        <label>Side<select value={side} onChange={(e) => setSide(e.target.value as typeof side)}><option value="receivable">Receivables</option><option value="payable">Payables</option></select></label>
        <DateField label="As at" value={asOf} onChange={setAsOf} hotkey />
      </ScreenHead>
      {data && data.parties.length === 0 ? <Empty>No open bills.</Empty> : data && (
        <table className="list">
          <thead><tr><th>Party</th>{cols.map(([, l]) => <th key={l} className="num">{l}</th>)}</tr></thead>
          <tbody>
            {data.parties.map((p) => (
              <FragmentRows key={p.ledgerId}>
                <tr tabIndex={0} className="clickable" onClick={() => setExpanded(expanded === p.ledgerId ? null : p.ledgerId)}
                  onKeyDown={(e) => { if (e.key === 'Enter') setExpanded(expanded === p.ledgerId ? null : p.ledgerId); }}>
                  <td>{expanded === p.ledgerId ? '▾' : '▸'} {p.party}</td>
                  {cols.map(([k]) => <td key={k} className={`num ${k === 'd90plus' || k === 'd61_90' ? 'overdue' : ''}`}>{inr(p.buckets[k], { blankZero: true })}</td>)}
                </tr>
                {expanded === p.ledgerId && p.bills.map((b) => (
                  <tr key={b.billRef} className="sub-row">
                    <td colSpan={2}>Bill {b.billRef} · {fmtDate(b.billDate)}{b.dueDate ? ` · due ${fmtDate(b.dueDate)}` : ''}</td>
                    <td colSpan={4}>{b.daysOverdue !== null && b.daysOverdue > 0 ? `${b.daysOverdue} days overdue` : b.daysOverdue === null ? 'on account' : 'not yet due'}</td>
                    <td className="num" colSpan={2}>{inr(b.amountMinor)}</td>
                  </tr>
                ))}
              </FragmentRows>
            ))}
          </tbody>
          <tfoot><tr><td>Total</td>{cols.map(([k]) => <td key={k} className="num">{inr(data.totals[k], { blankZero: true })}</td>)}</tr></tfoot>
        </table>
      )}
    </div>
  );
}
const FragmentRows = ({ children }: { children: React.ReactNode }) => <>{children}</>;

interface Statement {
  ledger: { id: string; name: string; group: string };
  openingMinor: string; closingMinor: string; totalDebitMinor: string; totalCreditMinor: string;
  lines: { voucherId: string; date: string; voucherNo: string; voucherType: string; amountMinor: string; particulars: string | null; narration: string | null; billRef: string | null; balanceMinor: string }[];
}

export function LedgerStatement({ params }: { params?: { ledgerId?: string; from?: string; to?: string } }) {
  const app = useApp();
  const [ledgerId, setLedgerId] = useState<string | null>(params?.ledgerId ?? null);
  const [to, setTo] = useState(params?.to ?? app.status.today);
  const [from, setFrom] = useState(params?.from ?? fyStart(app.status.today, app.company.fyStartMonth));
  const { data } = useReport<Statement>(ledgerId ? `/reports/ledger/${ledgerId}?from=${from}&to=${to}` : null, []);
  const options = useMemo(() => app.masters.ledgers.map((l) => ({ id: l.id, label: l.name, sub: l.groupName, right: drcr(l.balanceMinor) })), [app.masters.ledgers]);
  return (
    <div>
      <ScreenHead title={data?.ledger.name ?? 'Ledger statement'} sub={data ? `${data.ledger.group} · ${fmtDate(from)} to ${fmtDate(to)}` : 'Choose a ledger'}>
        <label className="grow">Ledger<Picker options={options} value={ledgerId} onChange={setLedgerId} placeholder="Type a ledger or party" autoFocus={!ledgerId} /></label>
        <DateField label="From" value={from} onChange={setFrom} hotkey /><DateField label="To" value={to} onChange={setTo} />
      </ScreenHead>
      {data && (
        <table className="list selectable">
          <thead><tr><th>Date</th><th>Particulars</th><th>Type</th><th>No.</th><th className="num">Debit ₹</th><th className="num">Credit ₹</th><th className="num">Balance</th></tr></thead>
          <tbody>
            <tr className="muted"><td>{fmtDate(from)}</td><td>Opening balance</td><td></td><td></td><td></td><td></td><td className="num">{drcr(data.openingMinor)}</td></tr>
            {data.lines.map((l, i) => {
              const a = BigInt(l.amountMinor);
              return (
                <tr key={i} tabIndex={0} onClick={() => app.go({ screen: 'voucher-view', params: { id: l.voucherId } })}
                  onKeyDown={(e) => { if (e.key === 'Enter') app.go({ screen: 'voucher-view', params: { id: l.voucherId } }); }}>
                  <td>{fmtDate(l.date)}</td>
                  <td>{l.particulars ?? '—'}{l.billRef && <small className="muted"> · bill {l.billRef}</small>}</td>
                  <td>{l.voucherType.replace('_', ' ').toLowerCase()}</td><td>{l.voucherNo}</td>
                  <td className="num">{a > 0n ? inr(a) : ''}</td><td className="num">{a < 0n ? inr(-a) : ''}</td>
                  <td className="num">{drcr(l.balanceMinor)}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot><tr><td colSpan={4}>Closing balance</td><td className="num">{inr(data.totalDebitMinor)}</td><td className="num">{inr(data.totalCreditMinor)}</td><td className="num">{drcr(data.closingMinor)}</td></tr></tfoot>
        </table>
      )}
    </div>
  );
}

export function StockSummary() {
  const app = useApp();
  const [asOf, setAsOf] = useState(app.status.today);
  const { data } = useReport<{ itemId: string; name: string; uom: string; hsnSac: string | null; method: string; qty: string; valueMinor: string; rate: string }[]>(`/reports/stock-summary?as_of=${asOf}`, []);
  const total = data?.reduce((s, r) => s + BigInt(r.valueMinor), 0n) ?? 0n;
  return (
    <div>
      <ScreenHead title="Stock Summary" sub={`closing stock as at ${fmtDate(asOf)}`}><DateField label="As at" value={asOf} onChange={setAsOf} hotkey /></ScreenHead>
      <table className="list">
        <thead><tr><th>Item</th><th>HSN</th><th>Method</th><th className="num">Quantity</th><th className="num">Rate ₹</th><th className="num">Value ₹</th></tr></thead>
        <tbody>{data?.map((r) => <tr key={r.itemId}><td>{r.name}</td><td>{r.hsnSac ?? '—'}</td><td>{r.method === 'FIFO' ? 'FIFO' : 'Wtd. avg.'}</td><td className="num">{Number(r.qty)} {r.uom}</td><td className="num">{r.rate}</td><td className="num">{inr(r.valueMinor)}</td></tr>)}</tbody>
        <tfoot><tr><td colSpan={5}>Total</td><td className="num">{inr(total)}</td></tr></tfoot>
      </table>
    </div>
  );
}

export function GstSummary() {
  const app = useApp();
  const [to, setTo] = useState(app.status.today);
  const [from, setFrom] = useState(`${app.status.today.slice(0, 8)}01`);
  type G = {
    byComponent: { component: string; outputMinor: string; rcmMinor: string; itcMinor: string; paidByCreditMinor: string; cashMinor: string; carryForwardMinor: string }[];
    netPayableMinor: string;
    carryForwardMinor: string;
    salesByRate: { kind: string; supply: string; ratePpm: number; taxableMinor: string; taxMinor: string }[];
  };
  const { data } = useReport<G>(`/reports/gst-summary?from=${from}&to=${to}`, []);
  return (
    <div>
      <ScreenHead title="GST Summary" sub={`${fmtDate(from)} to ${fmtDate(to)} · the figures behind GSTR-3B`}>
        <DateField label="From" value={from} onChange={setFrom} hotkey /><DateField label="To" value={to} onChange={setTo} />
      </ScreenHead>
      {data && <>
        <table className="list">
          <thead><tr><th>Tax</th><th className="num">Output ₹</th><th className="num">Input credit ₹</th><th className="num">Paid by credit ₹</th><th className="num">RCM (cash) ₹</th><th className="num">Cash payable ₹</th><th className="num">Credit carried ₹</th></tr></thead>
          <tbody>{data.byComponent.map((r) => (
            <tr key={r.component}><td>{r.component}</td><td className="num">{inr(r.outputMinor)}</td><td className="num">{inr(r.itcMinor)}</td>
              <td className="num">{inr(r.paidByCreditMinor, { blankZero: true })}</td><td className="num">{inr(r.rcmMinor, { blankZero: true })}</td>
              <td className="num">{inr(r.cashMinor)}</td><td className="num">{inr(r.carryForwardMinor, { blankZero: true })}</td></tr>
          ))}</tbody>
          <tfoot>
            <tr><td colSpan={5}>GST payable in cash</td><td className="num">{inr(data.netPayableMinor)}</td><td /></tr>
            {BigInt(data.carryForwardMinor) > 0n && <tr><td colSpan={6}>Input credit carried forward</td><td className="num">{inr(data.carryForwardMinor)}</td></tr>}
          </tfoot>
        </table>
        <p className="muted small">Credit is set off in the legal order: IGST credit first (against IGST, then CGST and SGST); CGST credit never pays SGST,
          nor SGST credit CGST. Tax under reverse charge is paid in cash.</p>
        <h3>Outward supplies by rate</h3>
        {data.salesByRate.length === 0 ? <Empty>No taxable sales in this period.</Empty> : (
          <table className="list">
            <thead><tr><th>Type</th><th>Supply</th><th>Rate</th><th className="num">Taxable ₹</th><th className="num">Tax ₹</th></tr></thead>
            <tbody>{data.salesByRate.map((r, i) => <tr key={i}><td>{r.kind}</td><td>{r.supply === 'INTER' ? 'Inter-state' : 'Intra-state'}</td><td>{pct(r.ratePpm)}</td><td className="num">{inr(r.taxableMinor)}</td><td className="num">{inr(r.taxMinor)}</td></tr>)}</tbody>
          </table>
        )}
        <p className="hint-bar">GSTR-1 / 3B JSON export and GSTR-2B reconciliation are Phase 4.</p>
      </>}
    </div>
  );
}
