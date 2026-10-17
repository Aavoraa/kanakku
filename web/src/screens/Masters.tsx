import { useEffect, useState } from 'react';
import { api, c, ApiError } from '../api';
import { useApp } from '../state';
import { useKeys } from '../keys';
import { ItemForm, LedgerForm, PartyForm } from '../components/QuickCreate';
import { ErrorBox, Kbd, ScreenHead } from '../components/ui';
import { drcr, inr, pct } from '../format';

type Tab = 'parties' | 'ledgers' | 'items' | 'groups';

export function Masters() {
  const app = useApp();
  const { masters } = app;
  const [tab, setTab] = useState<Tab>('parties');
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState('');
  useKeys({ 'Alt+C': () => setCreating(true), 'Alt+1': () => setTab('parties'), 'Alt+2': () => setTab('ledgers'), 'Alt+3': () => setTab('items'), 'Alt+4': () => setTab('groups') }, !creating);
  const f = filter.toLowerCase();
  const open = (ledgerId: string) => app.go({ screen: 'ledger', params: { ledgerId } });

  return (
    <div>
      <ScreenHead title="Masters" sub="Chart of accounts, parties and stock items">
        <input type="search" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter" />
        {tab !== 'groups' && <button className="primary" onClick={() => setCreating(true)}>Create <Kbd>Alt+C</Kbd></button>}
      </ScreenHead>
      <div className="tabs" role="tablist">
        {(['parties', 'ledgers', 'items', 'groups'] as Tab[]).map((t, i) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}><Kbd>{`Alt+${i + 1}`}</Kbd> {t[0].toUpperCase() + t.slice(1)}</button>
        ))}
      </div>

      {tab === 'parties' && (
        <table className="list selectable">
          <thead><tr><th>Name</th><th>Type</th><th>GSTIN</th><th>City</th><th className="num">Credit days</th><th className="num">Balance</th></tr></thead>
          <tbody>{masters.parties.filter((p) => !f || p.name.toLowerCase().includes(f) || p.gstin?.toLowerCase().includes(f)).map((p) => (
            <tr key={p.id} tabIndex={0} onClick={() => open(p.ledgerId)} onKeyDown={(e) => { if (e.key === 'Enter') open(p.ledgerId); }}>
              <td>{p.name}{p.status === 'PROVISIONAL' && <small className="tag">provisional</small>}</td>
              <td>{p.kind === 'CUSTOMER' ? 'Customer' : p.kind === 'SUPPLIER' ? 'Supplier' : p.groupName}</td>
              <td className="mono">{p.gstin ?? <span className="muted">unregistered</span>}</td><td>{p.city}</td>
              <td className="num">{p.creditDays ?? ''}</td><td className="num">{drcr(p.balanceMinor)}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
      {tab === 'ledgers' && (
        <table className="list selectable">
          <thead><tr><th>Ledger</th><th>Group</th><th className="num">Balance</th></tr></thead>
          <tbody>{masters.ledgers.filter((l) => !l.counterpartyId && (!f || l.name.toLowerCase().includes(f) || l.groupName.toLowerCase().includes(f))).map((l) => (
            <tr key={l.id} tabIndex={0} onClick={() => open(l.id)} onKeyDown={(e) => { if (e.key === 'Enter') open(l.id); }}>
              <td>{l.name}{l.systemCode && <small className="tag">system</small>}</td><td>{l.groupName}</td><td className="num">{drcr(l.balanceMinor)}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
      {tab === 'items' && (
        <table className="list">
          <thead><tr><th>Item</th><th>Unit</th><th>HSN/SAC</th><th>GST</th><th>Valuation</th><th className="num">On hand</th></tr></thead>
          <tbody>{masters.items.filter((i) => !f || i.name.toLowerCase().includes(f)).map((i) => (
            <tr key={i.id}><td>{i.name}</td><td>{i.uom}</td><td>{i.hsnSac ?? '—'}</td><td>{pct(i.gstRatePpm)}</td><td>{i.valuation === 'FIFO' ? 'FIFO' : 'Wtd. avg.'}</td><td className="num">{Number(i.qtyOnHand)}</td></tr>
          ))}</tbody>
        </table>
      )}
      {tab === 'groups' && <Groups filter={f} />}

      {creating && tab === 'parties' && <PartyForm onClose={() => setCreating(false)} onDone={() => { setCreating(false); app.bumpData(); }} />}
      {creating && tab === 'ledgers' && <LedgerForm onClose={() => setCreating(false)} onDone={() => { setCreating(false); app.bumpData(); }} />}
      {creating && tab === 'items' && <ItemForm onClose={() => setCreating(false)} onDone={() => setCreating(false)} />}
    </div>
  );
}

function Groups({ filter }: { filter: string }) {
  const app = useApp();
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState(app.masters.groups.find((g) => g.systemCode === 'INDIRECT_EXPENSES')?.id ?? '');
  const [err, setErr] = useState<{ message: string } | null>(null);
  const add = async () => {
    try {
      await api.post(c('/groups'), { name, parentId });
      setName(''); setErr(null);
      await app.refreshMasters();
      app.toast(`Group ${name} created`);
    } catch (e) { setErr({ message: e instanceof ApiError ? e.message : String(e) }); }
  };
  return (
    <>
      <table className="list">
        <thead><tr><th>Group</th><th>Nature</th></tr></thead>
        <tbody>{app.masters.groups.filter((g) => !filter || g.name.toLowerCase().includes(filter)).map((g) => (
          <tr key={g.id}><td style={{ paddingLeft: `${0.6 + (g.path.split('.').length - 1) * 1.2}rem` }}>{g.name}{g.systemCode && <small className="tag">standard</small>}</td><td>{g.nature.toLowerCase()}</td></tr>
        ))}</tbody>
      </table>
      <form className="inline-form" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <label>New sub-group<input value={name} onChange={(e) => setName(e.target.value)} required /></label>
        <label>Under<select value={parentId} onChange={(e) => setParentId(e.target.value)}>{app.masters.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select></label>
        <button type="submit">Add group</button>
        <ErrorBox error={err} />
      </form>
    </>
  );
}

export function Settings() {
  const app = useApp();
  const co = app.company;
  const [lockDate, setLockDate] = useState(co.lockDate ?? '');
  const [voiceLimit, setVoiceLimit] = useState(inr(co.voiceLimitMinor).replace(/,/g, ''));
  const [roundInvoice, setRoundInvoice] = useState(co.roundInvoice);
  const [gstin, setGstin] = useState(co.gstin ?? '');
  const [autoPost, setAutoPost] = useState(Boolean(co.autoPost));
  const [autoPostLimit, setAutoPostLimit] = useState(inr(co.autoPostLimitMinor ?? '5000000').replace(/,/g, ''));
  const [chain, setChain] = useState<{ ok: boolean; checked: number; head?: string; brokenAt?: { voucherNo: string } } | null>(null);
  const [err, setErr] = useState<{ message: string } | null>(null);
  const save = async () => {
    try {
      await api.patch(c(''), { lockDate: lockDate || null, voiceLimit, roundInvoice, gstin: gstin || null, autoPost, autoPostLimit });
      await app.refreshCompany();
      app.toast('Settings saved');
      setErr(null);
    } catch (e) { setErr({ message: e instanceof ApiError ? e.message : String(e) }); }
  };
  return (
    <div className="settings">
      <ScreenHead title="Company settings" sub={`${co.name} · books from ${co.booksFrom} · state ${co.stateCode} ${app.status.states[co.stateCode] ?? ''}`} />
      <form className="form-grid narrow" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <label>GSTIN<input value={gstin} onChange={(e) => setGstin(e.target.value.toUpperCase())} maxLength={15} /></label>
        <label>Lock books up to (no posting on or before)<input type="date" value={lockDate} onChange={(e) => setLockDate(e.target.value)} /></label>
        <label>Voice posting limit (₹) — above this, Ctrl+A is required<input value={voiceLimit} onChange={(e) => setVoiceLimit(e.target.value)} inputMode="decimal" /></label>
        <label className="check"><input type="checkbox" checked={roundInvoice} onChange={(e) => setRoundInvoice(e.target.checked)} /> Round invoice totals to the rupee</label>
        <label className="check"><input type="checkbox" checked={autoPost} onChange={(e) => setAutoPost(e.target.checked)} /> Auto-post uploaded documents: entries that pass every check are posted without waiting for you</label>
        {autoPost && <label>Auto-post only up to (₹ per entry) — larger ones wait for Ctrl+A<input value={autoPostLimit} onChange={(e) => setAutoPostLimit(e.target.value)} inputMode="decimal" /></label>}
        <ErrorBox error={err} />
        <div className="form-actions"><button className="primary" type="submit">Save</button></div>
      </form>
      <h3>Audit trail</h3>
      <p>Every posted voucher is hash-chained to the one before it. Re-walk the chain to prove nothing was edited.</p>
      <button onClick={() => void api.get<typeof chain>(c('/audit/verify-chain')).then(setChain)}>Verify hash chain</button>
      {chain && (chain.ok
        ? <p className="ok">Intact: {chain.checked} vouchers verified. Head <code>{chain.head?.slice(0, 24)}…</code></p>
        : <p className="bad">Broken at voucher {chain.brokenAt?.voucherNo}. The books were modified outside the posting engine.</p>)}
      <h3>AI</h3>
      <p>{app.status.aiEnabled ? `Bill reading and voice are on (model ${app.status.model}).` : 'Bill reading from PDFs and photos, and voice, are off.'}</p>
      <button onClick={() => app.setAiKeyOpen(true)}>{app.status.aiEnabled ? 'Manage API key' : 'Enter API key'}</button>
      <Backups />
    </div>
  );
}

interface BackupList { dir: string; files: { name: string; bytes: number }[] }

/** Whole-database backups: one is made automatically each day; the administrator can make and download them. */
function Backups() {
  const app = useApp();
  const [list, setList] = useState<BackupList | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    api.get<BackupList>('/api/v1/backups').then((l) => { if (live) setList(l); })
      .catch((e) => { if (live) setErr(e instanceof ApiError ? e.message : String(e)); });
    return () => { live = false; };
  }, []);
  const backupNow = async () => {
    setBusy(true);
    try {
      const made = await api.post<{ name: string }>('/api/v1/backups', {});
      setList(await api.get<BackupList>('/api/v1/backups'));
      app.toast(`Backup saved: ${made.name}`);
    } catch (e) { setErr(e instanceof ApiError ? e.message : String(e)); } finally { setBusy(false); }
  };
  const size = (b: number) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.ceil(b / 1e3)} KB`);
  return (
    <>
      <h3>Backups</h3>
      <p>A copy of the whole database (every company on this computer) is saved once a day; the last 14 are kept.
        Keep a recent one somewhere else too, such as a USB drive or cloud storage.</p>
      {err && <p className="muted">{err}</p>}
      {list && (
        <>
          <p className="muted small">Saved in <code>{list.dir}</code>. To restore one, stop the server and run <code>npm run restore-backup -- &lt;file&gt;</code>.</p>
          <button onClick={() => void backupNow()} disabled={busy}>{busy ? 'Backing up…' : 'Back up now'}</button>
          {list.files.length > 0 && (
            <ul className="small">
              {list.files.slice(0, 5).map((f) => (
                <li key={f.name}><a href={`/api/v1/backups/${encodeURIComponent(f.name)}`} download>{f.name}</a> <span className="muted">({size(f.bytes)})</span></li>
              ))}
            </ul>
          )}
        </>
      )}
    </>
  );
}
