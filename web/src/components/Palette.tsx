import { useMemo, useState } from 'react';
import { useApp, type Route } from '../state';
import { NAV } from '../nav';
import { Modal } from './ui';

interface Entry { label: string; sub: string; route: Route }

/** Ctrl+K / Alt+G: jump to any report, voucher type, ledger or party. */
export function Palette({ onClose }: { onClose: () => void }) {
  const app = useApp();
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const entries: Entry[] = useMemo(() => [
    ...NAV.flatMap((g) => g.items.map((m) => ({ label: m.label, sub: [g.title ?? 'Go to', m.key].filter(Boolean).join(' · '), route: m.route }))),
    ...(['CONTRA', 'CREDIT_NOTE', 'DEBIT_NOTE'] as const).map((t) => ({
      label: `New ${t.replace('_', ' ').toLowerCase()}`, sub: 'Voucher', route: { screen: 'voucher' as const, params: { type: t } },
    })),
    ...app.masters.ledgers.map((l) => ({ label: l.name, sub: `Ledger · ${l.groupName}`, route: { screen: 'ledger' as const, params: { ledgerId: l.id } } })),
  ], [app.masters.ledgers]);
  const list = useMemo(() => {
    const s = q.toLowerCase().trim();
    return (s ? entries.filter((e) => `${e.label} ${e.sub}`.toLowerCase().includes(s)) : entries).slice(0, 12);
  }, [q, entries]);
  const go = (e?: Entry) => { if (e) { app.open(e.route); onClose(); } };
  return (
    <Modal title="Go to" onClose={onClose}>
      <input className="palette-input" autoFocus value={q} placeholder="Report, voucher type, ledger or party…"
        onChange={(e) => { setQ(e.target.value); setHi(0); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, list.length - 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
          if (e.key === 'Enter') { e.preventDefault(); go(list[hi]); }
        }} />
      <ul className="palette-list">
        {list.map((e, i) => (
          <li key={`${e.label}-${i}`} className={i === hi ? 'hi' : ''} onMouseDown={() => go(e)}>{e.label}<small>{e.sub}</small></li>
        ))}
      </ul>
    </Modal>
  );
}
