import { useEffect, useRef, useState } from 'react';
import { api, c } from '../api';
import { useApp } from '../state';
import { useKeys, isTyping } from '../keys';
import { Empty, Kbd, ScreenHead, Stat } from '../components/ui';
import { fmtDate, inr, TYPE_LABEL } from '../format';

interface Row {
  id: string; voucherNo: string; date: string; voucherType: string; typeName: string; totalMinor: string; source: string;
  narration: string | null; partyRefNo: string | null; particulars: string | null; reversesVoucherId: string | null; reversedBy: string | null;
}

/** Total of one voucher type, leaving out reversed vouchers and their reversals. */
const sumOf = (rows: Row[], type: string) =>
  rows.filter((r) => r.voucherType === type && !r.reversesVoucherId && !r.reversedBy).reduce((s, r) => s + BigInt(r.totalMinor), 0n);

export function Daybook({ params }: { params?: { from?: string; to?: string; type?: string } }) {
  const app = useApp();
  const [from, setFrom] = useState(params?.from ?? app.status.today);
  const [to, setTo] = useState(params?.to ?? app.status.today);
  const [type, setType] = useState(params?.type ?? '');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [sel, setSel] = useState(0);
  const fromRef = useRef<HTMLInputElement>(null);
  const tbody = useRef<HTMLTableSectionElement>(null);

  useEffect(() => {
    const q = new URLSearchParams({ from, to, ...(type ? { type } : {}) });
    void api.get<Row[]>(c(`/vouchers?${q}`)).then((r) => { setRows(r); setSel(0); });
  }, [from, to, type, app.dataVersion]);

  useEffect(() => { (tbody.current?.children[sel] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' }); }, [sel]);

  const open = (r?: Row) => r && app.go({ screen: 'voucher-view', params: { id: r.id } });
  useKeys({
    'Alt+F2': () => { fromRef.current?.focus(); },
    F2: () => { fromRef.current?.focus(); },
    ArrowDown: (e) => { if (isTyping(e)) return false; setSel((s) => Math.min(s + 1, (rows?.length ?? 1) - 1)); },
    ArrowUp: (e) => { if (isTyping(e)) return false; setSel((s) => Math.max(s - 1, 0)); },
    Enter: (e) => { if (isTyping(e)) return false; open(rows?.[sel]); },
  });

  const total = rows?.filter((r) => !r.reversesVoucherId && !r.reversedBy).reduce((s, r) => s + BigInt(r.totalMinor), 0n) ?? 0n;

  return (
    <div>
      <ScreenHead title="Day Book" sub={`${fmtDate(from)} to ${fmtDate(to)} · ${rows ? `${rows.length} vouchers` : 'loading…'}`}>
        <label><span>From <Kbd>F2</Kbd></span><input ref={fromRef} type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <label>Type
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">All</option>
            {Object.entries(TYPE_LABEL).filter(([k]) => k !== 'OPENING').map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
      </ScreenHead>
      {rows && rows.length > 0 && (
        <section className="tiles" aria-label="Summary">
          <Stat label="Vouchers" value={rows.length} />
          <Stat label="Sales" value={`₹${inr(sumOf(rows, 'SALES'))}`} />
          <Stat label="Purchases" value={`₹${inr(sumOf(rows, 'PURCHASE'))}`} />
          <Stat label="Receipts" value={`₹${inr(sumOf(rows, 'RECEIPT'))}`} />
          <Stat label="Payments" value={`₹${inr(sumOf(rows, 'PAYMENT'))}`} />
          <Stat label="Total" value={`₹${inr(total)}`} note="excluding reversed pairs" />
        </section>
      )}
      {rows && rows.length === 0 ? <Empty>No vouchers in this period. Press <Kbd>F8</Kbd> to record a sale.</Empty> : (
        <table className="list selectable">
          <thead><tr><th>Date</th><th>Particulars</th><th>Type</th><th>No.</th><th className="num">Amount ₹</th><th>Via</th></tr></thead>
          <tbody ref={tbody}>
            {rows?.map((r, i) => (
              <tr key={r.id} className={`${i === sel ? 'sel' : ''} ${r.reversedBy || r.reversesVoucherId ? 'struck' : ''}`}
                onClick={() => { setSel(i); open(r); }}>
                <td>{fmtDate(r.date)}</td>
                <td>{r.particulars ?? '—'}{r.narration && <small className="muted"> · {r.narration}</small>}{r.reversedBy && <small className="tag">reversed by {r.reversedBy}</small>}</td>
                <td>{r.typeName}</td><td>{r.voucherNo}</td>
                <td className="num">{inr(r.totalMinor)}</td>
                <td><span className={`src src-${r.source.toLowerCase()}`}>{r.source.toLowerCase()}</span></td>
              </tr>
            ))}
          </tbody>
          <tfoot><tr><td colSpan={4}>Total (excluding reversed pairs)</td><td className="num">{inr(total)}</td><td></td></tr></tfoot>
        </table>
      )}
      <p className="hint-bar"><Kbd>↑↓</Kbd> select · <Kbd>Enter</Kbd> open · <Kbd>F2</Kbd> period · <Kbd>Esc</Kbd> back</p>
    </div>
  );
}
