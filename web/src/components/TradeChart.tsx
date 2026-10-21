import { useState } from 'react';
import { inr } from '../format';

export interface MonthPoint { month: string; salesMinor: string; purchasesMinor: string }

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (m: string) => `${MON[Number(m.slice(5, 7)) - 1]} ${m.slice(2, 4)}`;
const rupees = (minor: string) => Number(BigInt(minor) / 100n);
/** ₹ in Indian short form for axis ticks: 45K, 1.2L, 2.3Cr. */
export function compactINR(r: number): string {
  const a = Math.abs(r);
  const s = a >= 1e7 ? `${+(a / 1e7).toFixed(1)}Cr` : a >= 1e5 ? `${+(a / 1e5).toFixed(1)}L` : a >= 1e3 ? `${+(a / 1e3).toFixed(0)}K` : `${Math.round(a)}`;
  return `${r < 0 ? '-' : ''}₹${s}`;
}
/** A round axis top a little above the largest value (1, 2, 2.5 or 5 × a power of ten). */
function niceMax(v: number): number {
  if (v <= 0) return 1000;
  const p = 10 ** Math.floor(Math.log10(v));
  return ([1, 2, 2.5, 5, 10].map((m) => m * p).find((x) => x >= v) ?? 10 * p);
}

const SERIES = [
  { key: 'salesMinor', label: 'Sales', cls: 's1' },
  { key: 'purchasesMinor', label: 'Purchases', cls: 's2' },
] as const;

/**
 * Sales and purchases by month: grouped bars on one axis, a legend, values on the latest month, a hover tooltip per
 * month, and the same figures as a table for screen readers or on request.
 */
export function TradeChart({ data }: { data: MonthPoint[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const W = 640, H = 240, L = 52, R = 8, T = 18, B = 28;
  const values = data.flatMap((d) => [rupees(d.salesMinor), rupees(d.purchasesMinor)]);
  const top = niceMax(Math.max(...values, 0));
  const y = (v: number) => T + (H - T - B) * (1 - Math.max(0, v) / top);
  const groupW = (W - L - R) / data.length;
  const barW = Math.min(26, (groupW - 18) / 2);
  const empty = values.every((v) => v === 0);
  /** A bar with 4px rounded top corners, square at the baseline. */
  const bar = (x: number, v: number) => {
    const y0 = y(0), y1 = y(v), h = y0 - y1;
    if (h <= 0.5) return '';
    const r = Math.min(4, h, barW / 2);
    return `M${x},${y0} V${y1 + r} Q${x},${y1} ${x + r},${y1} H${x + barW - r} Q${x + barW},${y1} ${x + barW},${y1 + r} V${y0} Z`;
  };
  const last = data.length - 1;

  return (
    <div className="chart">
      <div className="chart-head">
        <div className="legend" aria-hidden>
          {SERIES.map((s) => <span key={s.key} className="legend-item"><i className={`swatch ${s.cls}`} />{s.label}</span>)}
        </div>
        <button className="ghost small" onClick={() => setTable((t) => !t)} aria-pressed={table}>{table ? 'Show chart' : 'Show table'}</button>
      </div>
      {table || empty ? (
        empty && !table ? <p className="muted small chart-empty">No sales or purchases in the last six months yet.</p> : (
          <table className="list chart-table">
            <thead><tr><th>Month</th><th className="num">Sales ₹</th><th className="num">Purchases ₹</th></tr></thead>
            <tbody>{data.map((d) => <tr key={d.month}><td>{monthLabel(d.month)}</td><td className="num">{inr(d.salesMinor)}</td><td className="num">{inr(d.purchasesMinor)}</td></tr>)}</tbody>
          </table>
        )
      ) : (
        <div className="chart-plot" onMouseLeave={() => setHover(null)}>
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Sales and purchases by month, ${data.map((d) => `${monthLabel(d.month)}: sales ${compactINR(rupees(d.salesMinor))}, purchases ${compactINR(rupees(d.purchasesMinor))}`).join('; ')}`}>
            {[0, 0.25, 0.5, 0.75, 1].map((f) => (
              <g key={f}>
                <line className="grid-line" x1={L} x2={W - R} y1={y(top * f)} y2={y(top * f)} />
                <text className="axis-label" x={L - 8} y={y(top * f) + 4} textAnchor="end">{compactINR(top * f)}</text>
              </g>
            ))}
            {data.map((d, i) => {
              const gx = L + groupW * i;
              const x1 = gx + (groupW - (barW * 2 + 2)) / 2;
              return (
                <g key={d.month}>
                  {hover === i && <rect className="hover-band" x={gx + 2} y={T} width={groupW - 4} height={H - T - B} rx={6} />}
                  <path className="bar s1" d={bar(x1, rupees(d.salesMinor))} />
                  <path className="bar s2" d={bar(x1 + barW + 2, rupees(d.purchasesMinor))} />
                  {i === last && rupees(d.salesMinor) > 0 && <text className="value-label" x={x1 + barW / 2} y={y(rupees(d.salesMinor)) - 5} textAnchor="middle">{compactINR(rupees(d.salesMinor))}</text>}
                  {i === last && rupees(d.purchasesMinor) > 0 && <text className="value-label" x={x1 + barW * 1.5 + 2} y={y(rupees(d.purchasesMinor)) - 5} textAnchor="middle">{compactINR(rupees(d.purchasesMinor))}</text>}
                  <text className="axis-label" x={gx + groupW / 2} y={H - 8} textAnchor="middle">{monthLabel(d.month)}</text>
                  {/* The whole month column answers the hover, not just the thin bars. */}
                  <rect x={gx} y={T} width={groupW} height={H - T - B} fill="transparent" onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} />
                </g>
              );
            })}
            <line className="baseline" x1={L} x2={W - R} y1={y(0)} y2={y(0)} />
          </svg>
          {hover !== null && (
            <div className="chart-tip" style={{ left: `${((L + groupW * hover + groupW / 2) / W) * 100}%` }} role="status">
              <strong>{monthLabel(data[hover].month)}</strong>
              {SERIES.map((s) => <span key={s.key}><i className={`swatch ${s.cls}`} />{s.label} <b className="num">₹{inr(data[hover][s.key])}</b></span>)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
