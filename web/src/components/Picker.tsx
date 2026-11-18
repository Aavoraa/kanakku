import { forwardRef, useEffect, useId, useMemo, useRef, useState } from 'react';

export interface Option {
  id: string;
  label: string;
  sub?: string;
  right?: string;
  keywords?: string;
}

interface Props {
  options: Option[];
  value: string | null | undefined;
  onChange: (id: string | null) => void;
  placeholder?: string;
  onCreate?: (query: string) => void;
  autoFocus?: boolean;
  className?: string;
  ariaLabel?: string;
}

function score(o: Option, q: string): number {
  if (!q) return 1;
  const label = o.label.toLowerCase();
  const hay = `${label} ${o.keywords ?? ''} ${o.sub ?? ''}`.toLowerCase();
  if (label.startsWith(q)) return 3;
  if (label.split(/\s+/).some((w) => w.startsWith(q))) return 2;
  if (hay.includes(q)) return 1;
  // Initials: "sbc" -> "Shree Balaji Cement"
  const initials = label.split(/\s+/).map((w) => w[0]).join('');
  return initials.startsWith(q) ? 1 : 0;
}

/** Type-ahead picker: type to filter, arrows to move, Enter to pick, Alt+C to create. */
export const Picker = forwardRef<HTMLInputElement, Props>(function Picker(
  { options, value, onChange, placeholder, onCreate, autoFocus, className, ariaLabel }, ref,
) {
  const selected = options.find((o) => o.id === value) ?? null;
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  // Focus stays in the input, so screen readers learn the highlighted option through aria-activedescendant.
  const listId = useId();
  const optId = (i: number) => `${listId}-${i}`;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return options
      .map((o) => ({ o, s: score(o, q) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 50)
      .map((x) => x.o);
  }, [options, query]);

  useEffect(() => setHi(0), [query]);
  useEffect(() => {
    listRef.current?.children[hi]?.scrollIntoView({ block: 'nearest' });
  }, [hi]);

  const pick = (o: Option | undefined) => {
    if (!o) return;
    onChange(o.id);
    setQuery('');
    setOpen(false);
  };

  return (
    <div className={`picker ${className ?? ''}`}>
      <input
        ref={ref}
        autoFocus={autoFocus}
        aria-label={ariaLabel ?? placeholder}
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={open && filtered[hi] ? optId(hi) : undefined}
        placeholder={placeholder}
        value={open ? query : selected?.label ?? ''}
        onFocus={() => { setOpen(true); setQuery(''); }}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setHi((h) => Math.min(h + 1, filtered.length - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
          else if (e.key === 'Enter' && open && filtered.length && (query || !selected)) {
            pick(filtered[hi]);
            // let the form's Enter handler move focus on
          } else if (e.key === 'Escape' && open && query) {
            e.preventDefault(); e.stopPropagation(); setQuery('');
          } else if ((e.key === 'c' || e.key === 'C') && e.altKey && onCreate) {
            e.preventDefault(); e.stopPropagation(); setOpen(false); onCreate(query);
          } else if (e.key === 'Backspace' && !query && selected && open) {
            onChange(null);
          }
        }}
      />
      {open && (
        <ul className="picker-list" ref={listRef} role="listbox" id={listId}>
          {filtered.map((o, i) => (
            <li key={o.id} id={optId(i)} role="option" aria-selected={i === hi} className={i === hi ? 'hi' : ''}
              onMouseDown={(e) => { e.preventDefault(); pick(o); }}>
              <span className="pl-label">{o.label}{o.sub && <small>{o.sub}</small>}</span>
              {o.right && <span className="pl-right num">{o.right}</span>}
            </li>
          ))}
          {!filtered.length && <li className="empty">No match{onCreate ? ' · Alt+C to create' : ''}</li>}
          {filtered.length > 0 && onCreate && <li className="hint">Alt+C create new</li>}
        </ul>
      )}
    </div>
  );
});
