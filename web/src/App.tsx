import { useEffect, useState } from 'react';
import { AppProvider, useApp, type Route } from './state';
import { dispatchKey, pressKey, useGlobalKeys } from './keys';
import { Kbd } from './components/ui';
import { Palette } from './components/Palette';
import { VoicePanel } from './components/Voice';
import { Gateway } from './screens/Gateway';
import { VoucherEntry } from './screens/VoucherEntry';
import { Daybook } from './screens/Daybook';
import { VoucherView } from './screens/VoucherView';
import { Ageing, BalanceSheet, GstSummary, LedgerStatement, ProfitLoss, StockSummary, TrialBalance } from './screens/Reports';
import { Masters, Settings } from './screens/Masters';
import { DocumentScreen, DocumentsQueue } from './screens/Documents';
import { fmtDate } from './format';
import { Modal } from './components/ui';
import { CompanyForm } from './components/CompanyForm';
import { AiKeyDialog } from './components/AiKey';
import { AlertsBell } from './components/Alerts';
import { Compliance } from './screens/Compliance';
import { Profile } from './screens/Profile';
import { PettyCash } from './screens/PettyCash';
import { Assets } from './screens/Assets';
import { Upkeep } from './screens/Upkeep';

const KEYBAR: [string, string][] = [
  ['Escape', 'Back'], ['F8', 'Sales'], ['F9', 'Purchase'], ['F5', 'Payment'], ['F6', 'Receipt'], ['F4', 'Contra'], ['F7', 'Journal'],
  ['Ctrl+U', 'Upload documents'], ['Alt+H', 'Home'],
];

const VOUCHER_KEYS: Record<string, string> ={ F4: 'CONTRA', F5: 'PAYMENT', F6: 'RECEIPT', F7: 'JOURNAL', F8: 'SALES', F9: 'PURCHASE', 'Alt+F6': 'CREDIT_NOTE', 'Alt+F5': 'DEBIT_NOTE' };

function Screen({ route }: { route: Route }) {
  const p = route.params ?? {};
  switch (route.screen) {
    case 'voucher': return <VoucherEntry params={p} />;
    case 'daybook': return <Daybook params={p} />;
    case 'voucher-view': return <VoucherView params={p as { id: string }} />;
    case 'tb': return <TrialBalance />;
    case 'pl': return <ProfitLoss />;
    case 'bs': return <BalanceSheet />;
    case 'ageing': return <Ageing params={p} />;
    case 'ledger': return <LedgerStatement params={p} />;
    case 'stock': return <StockSummary />;
    case 'gst': return <GstSummary />;
    case 'masters': return <Masters />;
    case 'review': return <DocumentsQueue params={p} />;
    case 'review-doc': return <DocumentScreen params={p as { id: string }} />;
    case 'settings': return <Settings />;
    case 'compliance': return <Compliance />;
    case 'profile': return <Profile />;
    case 'petty-cash': return <PettyCash />;
    case 'assets': return <Assets />;
    case 'upkeep': return <Upkeep />;
    default: return <Gateway />;
  }
}

function Shell({ toasts }: { toasts: { id: number; msg: string; kind: string }[] }) {
  const app = useApp();
  const [palette, setPalette] = useState(false);
  const [voice, setVoice] = useState(false);
  const [wake, setWake] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { dispatchKey(e); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Global keys: any screen's own map takes precedence.
  const global: Record<string, () => boolean | void> = {
    'Ctrl+K': () => setPalette(true),
    'Alt+G': () => setPalette(true),
    'Ctrl+U': () => app.go({ screen: 'review', params: { upload: true } }),
    'Alt+H': () => app.home(),
    Escape: () => { if (app.stackDepth > 1) app.back(); else return false; },
  };
  for (const [k, t] of Object.entries(VOUCHER_KEYS)) global[k] = () => app.go({ screen: 'voucher', params: { type: t } });
  useGlobalKeys(global);

  const route = app.route;
  return (
    <div className="app">
      <header className="topbar">
        <button className="brand" onClick={app.home} title="Gateway (Alt+H)">Kannaku AI</button>
        <CompanySwitcher />
        <div className="top-actions">
          <button onClick={() => setPalette(true)}>Go to <Kbd>Ctrl+K</Kbd></button>
          <button className={`voice-btn ${voice ? 'on' : ''}`} onClick={() => setVoice((v) => !v)}
            title={wake ? 'Listening for “Kannaku”. Hold Ctrl+Space to talk' : 'Hold Ctrl+Space to talk'}>{wake && <span className="wake-dot on" aria-label="Listening for Kannaku" />}Voice <Kbd>Ctrl+Space</Kbd></button>
          <button className={`ai-chip ${app.status.aiEnabled ? 'on' : 'off'}`} onClick={() => app.setAiKeyOpen(true)}
            title={app.status.aiEnabled ? `AI on, model ${app.status.model}. Click to manage the API key` : 'Click to enter your Anthropic API key'}>AI {app.status.aiEnabled ? 'on' : 'off'}</button>
          <AlertsBell />
          <UserMenu />
        </div>
      </header>

      <main className="content" key={`${route.screen}-${app.stackDepth}`}>
        <Screen route={route} />
      </main>

      {/* Each shortcut can also be clicked; a click does what the key does on the current screen. */}
      <footer className="keybar" aria-label="Keyboard shortcuts">
        {(app.stackDepth > 1 ? KEYBAR : KEYBAR.filter(([k]) => k !== 'Escape')).map(([k, label]) => (
          <button key={k} type="button" onClick={() => pressKey(k)} title={`${label} (${k === 'Escape' ? 'Esc' : k})`}>
            <Kbd>{k === 'Escape' ? 'Esc' : k}</Kbd> {label}
          </button>
        ))}
      </footer>

      {palette && <Palette onClose={() => setPalette(false)} />}
      {app.aiKeyOpen && <AiKeyDialog onClose={() => app.setAiKeyOpen(false)} />}
      <VoicePanel open={voice} onOpen={() => setVoice(true)} onClose={() => setVoice(false)} onWakeChange={setWake} />
      <div className="toasts" aria-live="polite">{toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.msg}</div>)}</div>
    </div>
  );
}

export default function App() {
  return <AppProvider>{(toasts) => <Shell toasts={toasts} />}</AppProvider>;
}

/** Company name in the top bar; opens a list of the user's businesses and "Add a business". */
function CompanySwitcher() {
  const app = useApp();
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest('.company-switch')) setOpen(false); };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div className="company-switch">
      <button className="company" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} title="Switch business">
        <strong>{app.company.name} <span aria-hidden>▾</span></strong>
        <span className="muted">{app.company.gstin ?? 'GSTIN not set'} · {fmtDate(app.status.today)}</span>
      </button>
      {open && (
        <div className="menu-pop" role="menu">
          {app.companies.map((co) => (
            <button key={co.id} role="menuitemradio" aria-checked={co.id === app.company.id} className={co.id === app.company.id ? 'on' : ''}
              onClick={() => { setOpen(false); if (co.id !== app.company.id) app.switchCompany(co.id); }}>
              <span>{co.name}</span><small>{co.gstin ?? app.status.states[co.stateCode] ?? ''}</small>
            </button>
          ))}
          <hr />
          <button role="menuitem" onClick={() => { setOpen(false); setAdding(true); }}>+ Add a business</button>
        </div>
      )}
      {adding && (
        <Modal title="Add a business" onClose={() => setAdding(false)}>
          <CompanyForm states={app.status.states} submitLabel="Create books" onCreated={(id) => { setAdding(false); void app.reloadCompanies(id); app.toast('Business added'); }} />
        </Modal>
      )}
    </div>
  );
}

function UserMenu() {
  const app = useApp();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest('.user-menu')) setOpen(false); };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  const initials = app.user.name.trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  return (
    <div className="user-menu">
      <button className="avatar" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} title={app.user.name}>{initials}</button>
      {open && (
        <div className="menu-pop right" role="menu">
          <div className="menu-who"><strong>{app.user.name}</strong><small>{app.user.email}</small></div>
          <hr />
          <button role="menuitem" onClick={() => { setOpen(false); app.go({ screen: 'profile' }); }}>My profile and password</button>
          <button role="menuitem" onClick={() => { setOpen(false); app.go({ screen: 'settings' }); }}>Company settings</button>
          <button role="menuitem" onClick={() => void app.logout()}>Log out</button>
        </div>
      )}
    </div>
  );
}
