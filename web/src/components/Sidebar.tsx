import { useEffect, useState } from 'react';
import { api, c } from '../api';
import { useApp } from '../state';
import { NAV, isActive } from '../nav';
import { Icon } from './Icon';

/** Left navigation: every page, grouped, with its shortcut key and live counts. On a phone it slides in as a drawer. */
export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const app = useApp();
  const [counts, setCounts] = useState<{ pendingDocuments: number; overdue: number; dueSoon: number } | null>(null);
  useEffect(() => {
    let live = true;
    void api.get<typeof counts>(c('/counts')).then((x) => { if (live) setCounts(x); }).catch(() => {});
    return () => { live = false; };
  }, [app.dataVersion, app.company.id]);
  const badge = (b?: 'documents' | 'alerts') => {
    if (!counts || !b) return null;
    if (b === 'documents' && counts.pendingDocuments) return <span className="nav-badge">{counts.pendingDocuments}</span>;
    if (b === 'alerts' && counts.overdue + counts.dueSoon) return <span className={`nav-badge ${counts.overdue ? 'bad' : ''}`}>{counts.overdue + counts.dueSoon}</span>;
    return null;
  };
  return (
    <>
      <div className={`sidebar-scrim ${open ? 'show' : ''}`} onClick={onClose} aria-hidden />
      <nav className={`sidebar ${open ? 'open' : ''}`} aria-label="Main">
        <button className="brand" onClick={() => { app.open({ screen: 'gateway' }); onClose(); }} title="Home (Alt+H)">
          <span className="brand-mark" aria-hidden>K</span>
          <span className="brand-name">Kannaku <b>AI</b></span>
        </button>
        <div className="nav-scroll">
          {NAV.map((g) => (
            <div key={g.title ?? 'top'} className="nav-group">
              {g.title && <div className="nav-title">{g.title}</div>}
              {g.items.map((it) => {
                const active = isActive(it, app.route);
                return (
                  <button key={it.label} className={`nav-item ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined}
                    onClick={() => { app.open(it.route); onClose(); }} title={it.key ? `${it.label} (${it.key})` : it.label}>
                    <Icon name={it.icon} />
                    <span className="nav-label">{it.label}</span>
                    {badge(it.badge)}
                    {it.key && <kbd className="nav-key">{it.key}</kbd>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <div className="sidebar-foot muted small">Letters open pages from Home · <kbd>Ctrl+K</kbd> finds anything</div>
      </nav>
    </>
  );
}
