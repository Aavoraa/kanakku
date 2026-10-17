import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, c, onUnauthenticated, setCompany, type Company, type Group, type Item, type Ledger, type Party, type Status, type Uom, type User } from './api';
import { AuthScreen } from './screens/Auth';
import { CompanyForm } from './components/CompanyForm';

export type Screen =
  | 'gateway' | 'voucher' | 'daybook' | 'voucher-view' | 'tb' | 'pl' | 'bs' | 'ageing' | 'ledger'
  | 'stock' | 'gst' | 'masters' | 'review' | 'review-doc' | 'settings' | 'compliance';

export interface Route { screen: Screen; params?: Record<string, any> }

interface Masters {
  ledgers: Ledger[];
  parties: Party[];
  items: Item[];
  groups: Group[];
  uoms: Uom[];
}

interface AppState {
  status: Status;
  user: User;
  company: Company;
  companies: Company[];
  switchCompany: (id: string) => void;
  reloadCompanies: (selectId?: string) => Promise<void>;
  logout: () => Promise<void>;
  masters: Masters;
  refreshMasters: () => Promise<void>;
  refreshCompany: () => Promise<void>;
  route: Route;
  stackDepth: number;
  go: (r: Route) => void;
  replace: (r: Route) => void;
  back: () => void;
  home: () => void;
  toast: (msg: string, kind?: 'ok' | 'error' | 'info') => void;
  dataVersion: number;
  bumpData: () => void;
  refreshStatus: () => Promise<void>;
  /** The API key dialog (top bar AI chip, and the "AI is off" notices). */
  aiKeyOpen: boolean;
  setAiKeyOpen: (open: boolean) => void;
}

const Ctx = createContext<AppState | null>(null);
export const useApp = () => {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside provider');
  return v;
};

const COMPANY_KEY = 'kannaku.company';
const rememberCompany = (id: string) => { try { localStorage.setItem(COMPANY_KEY, id); } catch { /* storage blocked */ } };
const lastCompany = () => { try { return localStorage.getItem(COMPANY_KEY); } catch { return null; } };

export function AppProvider({ children }: { children: (toasts: { id: number; msg: string; kind: string }[]) => ReactNode }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyId, setCompanyIdState] = useState<string | null>(null);
  const [masters, setMasters] = useState<Masters>({ ledgers: [], parties: [], items: [], groups: [], uoms: [] });
  const [stack, setStack] = useState<Route[]>([{ screen: 'gateway' }]);
  const [toasts, setToasts] = useState<{ id: number; msg: string; kind: string }[]>([]);
  const [dataVersion, setDataVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [aiKeyOpen, setAiKeyOpen] = useState(false);

  const toast = useCallback((msg: string, kind: 'ok' | 'error' | 'info' = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 4000);
  }, []);

  const mastersCall = useRef(0);
  const refreshMasters = useCallback(async () => {
    // Only the newest call may apply, so a slow refresh started before a company switch cannot
    // fill in the other company's ledgers.
    const call = ++mastersCall.current;
    const [ledgers, parties, items, groups, uoms] = await Promise.all([
      api.get<Ledger[]>(c('/ledgers')), api.get<Party[]>(c('/parties')), api.get<Item[]>(c('/items')),
      api.get<Group[]>(c('/groups')), api.get<Uom[]>(c('/uoms')),
    ]);
    if (call === mastersCall.current) setMasters({ ledgers, parties, items, groups, uoms });
  }, []);

  /** Loads the user's companies and opens one: the requested one, the last used, or the first. */
  const reloadCompanies = useCallback(async (selectId?: string) => {
    const list = await api.get<Company[]>('/api/v1/companies');
    setCompanies(list);
    const pick = list.find((x) => x.id === selectId) ?? list.find((x) => x.id === lastCompany()) ?? list[0] ?? null;
    if (pick) {
      setCompany(pick.id);
      rememberCompany(pick.id);
      setCompanyIdState(pick.id);
      setStack([{ screen: 'gateway' }]);
      await refreshMasters();
    } else {
      setCompanyIdState(null);
    }
  }, [refreshMasters]);

  const refreshCompany = useCallback(async () => {
    setCompanies(await api.get<Company[]>('/api/v1/companies'));
  }, []);

  // Boot: status, then who is logged in.
  useEffect(() => {
    (async () => {
      try {
        setStatus(await api.get<Status>('/api/v1/status'));
        try {
          const me = await api.get<{ user: User }>('/api/v1/auth/me');
          setUser(me.user);
          await reloadCompanies();
        } catch { /* not logged in */ }
        setAuthChecked(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [reloadCompanies]);

  // Any 401 (session expired, logged out in another tab) returns to the login screen.
  useEffect(() => onUnauthenticated(() => { setUser(null); setCompanyIdState(null); }), []);

  const logout = useCallback(async () => {
    await api.post('/api/v1/auth/logout', {}).catch(() => {});
    setStatus(await api.get<Status>('/api/v1/status').catch(() => null));
    setUser(null);
    setCompanies([]);
    setCompanyIdState(null);
    setStack([{ screen: 'gateway' }]);
  }, []);

  const company = companies.find((x) => x.id === companyId) ?? null;
  const value = useMemo<AppState | null>(() => (status && user && company ? {
    status, user, company, companies,
    switchCompany: (id: string) => { void reloadCompanies(id); },
    reloadCompanies, logout,
    masters, refreshMasters, refreshCompany,
    route: stack[stack.length - 1],
    stackDepth: stack.length,
    go: (r) => setStack((s) => [...s, r]),
    replace: (r) => setStack((s) => [...s.slice(0, -1), r]),
    back: () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)),
    home: () => setStack([{ screen: 'gateway' }]),
    toast,
    dataVersion,
    bumpData: () => { setDataVersion((v) => v + 1); void refreshMasters(); },
    refreshStatus: async () => { setStatus(await api.get<Status>('/api/v1/status')); },
    aiKeyOpen, setAiKeyOpen,
  } : null), [status, user, company, companies, reloadCompanies, logout, masters, refreshMasters, refreshCompany, stack, toast, dataVersion, aiKeyOpen]);

  if (error) return <div className="boot-error"><h1>Kannaku AI could not start</h1><p>{error}</p><p>Is the server running? Start it with <code>npm start</code> in the project folder.</p></div>;
  if (!status || !authChecked) return <div className="boot">Loading…</div>;
  if (!user) {
    return <AuthScreen key={String(status.hasUsers)} status={status} onAuthed={async (u, openId) => {
      setUser(u);
      await reloadCompanies(openId);
      setStatus(await api.get<Status>('/api/v1/status'));
    }} />;
  }
  if (!company) {
    if (companies.length === 0 && !companyId) {
      return (
        <div className="auth-page">
          <div className="auth-card">
            <h1 className="auth-brand">Kannaku AI</h1>
            <p>Welcome, {user.name}. Add your business to start.</p>
            <CompanyForm states={status.states} submitLabel="Create my books" onCreated={(id) => reloadCompanies(id)} />
            <button className="link" onClick={() => void logout()}>Log out</button>
          </div>
        </div>
      );
    }
    return <div className="boot">Opening books…</div>;
  }
  return <Ctx.Provider value={value}>{children(toasts)}</Ctx.Provider>;
}
