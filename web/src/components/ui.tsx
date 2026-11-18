import { useEffect, useRef, type ReactNode } from 'react';
import { useKeys } from '../keys';
import { inr, drcr } from '../format';
import type { TreeNode } from '../api';

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  // A modal map: while the dialog is open the screen's shortcuts (Ctrl+A post, F-keys) stay off.
  useKeys({ Escape: () => { onClose(); } }, true, true);
  const ref = useRef<HTMLDivElement>(null);
  // Focus the first field, not the close button that precedes it in the DOM.
  useEffect(() => { (ref.current?.querySelector<HTMLElement>('input,select,textarea') ?? ref.current?.querySelector<HTMLElement>('button'))?.focus(); }, []);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-label={title} ref={ref}>
        <div className="modal-head"><h2>{title}</h2><button className="ghost" onClick={onClose} aria-label="Close">Esc</button></div>
        {children}
      </div>
    </div>
  );
}

export function ScreenHead({ title, sub, children }: { title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="screen-head">
      <div>
        <h1>{title}</h1>
        {sub && <div className="sub">{sub}</div>}
      </div>
      <div className="head-actions">{children}</div>
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd>{children}</kbd>;
}

export function Money({ v, dc, blankZero }: { v: string | bigint | null | undefined; dc?: boolean; blankZero?: boolean }) {
  return <span className="num">{dc ? drcr(v) : inr(v, { blankZero })}</span>;
}

/** Collapsible report tree. Ledger rows drill down on click / Enter. */
export function Tree({ nodes, depth = 0, onLedger, mode = 'single' }: {
  nodes: TreeNode[]; depth?: number; onLedger?: (id: string) => void; mode?: 'single' | 'drcr';
}) {
  return (
    <>
      {nodes.map((n) => (
        <TreeRow key={`${n.kind}:${n.id}`} node={n} depth={depth} onLedger={onLedger} mode={mode} />
      ))}
    </>
  );
}

function TreeRow({ node, depth, onLedger, mode }: { node: TreeNode; depth: number; onLedger?: (id: string) => void; mode: 'single' | 'drcr' }) {
  const v = BigInt(node.amountMinor);
  const clickable = node.kind === 'ledger' && onLedger;
  const cells = mode === 'drcr'
    ? <><td className="num">{v > 0n ? inr(v) : ''}</td><td className="num">{v < 0n ? inr(-v) : ''}</td></>
    : <td className="num">{inr(v)}</td>;
  return (
    <>
      <tr className={`tree-row d${Math.min(depth, 3)} ${node.kind}`} tabIndex={clickable ? 0 : undefined}
        onClick={clickable ? () => onLedger!(node.id) : undefined}
        onKeyDown={clickable ? (e) => { if (e.key === 'Enter') onLedger!(node.id); } : undefined}>
        <td style={{ paddingLeft: `${0.6 + depth * 1.1}rem` }}>{node.name}</td>
        {cells}
      </tr>
      {node.children.length > 0 && depth < 4 && <Tree nodes={node.children} depth={depth + 1} onLedger={onLedger} mode={mode} />}
    </>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty-state">{children}</div>;
}

export function ErrorBox({ error }: { error: { message: string; details?: unknown } | null }) {
  if (!error) return null;
  const details = Array.isArray(error.details) ? error.details as { path?: string; message: string }[] : null;
  return (
    <div className="error-box" role="alert">
      {error.message}
      {details && <ul>{details.map((d, i) => <li key={i}>{d.path ? `${d.path}: ` : ''}{d.message}</li>)}</ul>}
    </div>
  );
}

/** One tile on a screen's grid: a card with an optional heading and an action beside it. `wide` takes the whole row. */
export function Panel({ title, action, wide, className, children }: { title?: ReactNode; action?: ReactNode; wide?: boolean; className?: string; children: ReactNode }) {
  return (
    <section className={['panel', wide && 'wide', className].filter(Boolean).join(' ')}>
      {(title || action) && <div className="panel-head">{title && <h3>{title}</h3>}{action}</div>}
      {children}
    </section>
  );
}

/** A figure tile for a screen's summary row: label, value, and an optional note under it. */
export function Stat({ label, value, note, warn, bad }: { label: ReactNode; value: ReactNode; note?: ReactNode; warn?: boolean; bad?: boolean }) {
  return (
    <div className={`tile ${warn ? 'tile-warn' : ''}`}>
      <span className="tile-label">{label}</span>
      <span className="tile-value num">{value}</span>
      {note && <span className={`tile-note ${bad ? 'bad' : ''}`}>{note}</span>}
    </div>
  );
}
