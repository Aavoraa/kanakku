import { useState } from 'react';
import { api, c, ApiError, type Group, type Item, type Ledger, type Party } from '../api';
import { useApp } from '../state';
import { ErrorBox, Modal } from './ui';

type Err = { message: string; details?: unknown } | null;
const asErr = (e: unknown): Err => (e instanceof ApiError ? { message: e.message, details: e.details } : { message: String(e) });

/** Saves a change, refreshes the lists everywhere, and closes. Switching off asks first. */
function useSave(url: string, onDone: () => void) {
  const app = useApp();
  const [err, setErr] = useState<Err>(null);
  const [busy, setBusy] = useState(false);
  const save = async (body: Record<string, unknown>, done: string) => {
    setBusy(true);
    try { await api.patch(c(url), body); await app.refreshMasters(); app.bumpData(); app.toast(done); onDone(); }
    catch (e) { setErr(asErr(e)); } finally { setBusy(false); }
  };
  return { err, busy, save };
}

function ActiveToggle({ active, busy, label, onToggle }: { active: boolean; busy: boolean; label: string; onToggle: (on: boolean) => void }) {
  return (
    <div className="span-2 switch-row">
      {active
        ? <><span className="muted small">Switching off hides it from new entries; its history stays. Allowed once its balance is zero.</span>
          <button type="button" className="danger" disabled={busy} onClick={() => { if (window.confirm(`Switch off ${label}? It will not appear in new entries.`)) onToggle(false); }}>Switch off</button></>
        : <><span className="muted small">Switched off: hidden from new entries.</span>
          <button type="button" disabled={busy} onClick={() => onToggle(true)}>Switch on again</button></>}
    </div>
  );
}

export function EditParty({ party: p, onClose }: { party: Party; onClose: () => void }) {
  const app = useApp();
  const [f, setF] = useState({
    name: p.name, kind: p.kind === 'SUPPLIER' ? 'SUPPLIER' : 'CUSTOMER', gstin: p.gstin ?? '', stateCode: p.stateCode ?? '', city: p.city ?? '',
    phone: p.phone ?? '', creditDays: p.creditDays === null ? '' : String(p.creditDays), regType: p.regType ?? '',
  });
  const { err, busy, save } = useSave(`/parties/${p.id}`, onClose);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const submit = () => save({
    name: f.name, kind: p.kind === 'OTHER' ? undefined : f.kind, gstin: f.gstin || null, stateCode: f.stateCode || null, city: f.city, phone: f.phone,
    creditDays: f.creditDays === '' ? null : f.creditDays, regType: f.regType || null,
  }, `Saved ${f.name}`);
  return (
    <Modal title={`Alter party: ${p.name}`} onClose={onClose}>
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <label>Name<input value={f.name} onChange={set('name')} required /></label>
        {p.kind !== 'OTHER' && (
          <label>Type<select value={f.kind} onChange={set('kind')}>
            <option value="CUSTOMER">Customer (Sundry Debtors)</option><option value="SUPPLIER">Supplier (Sundry Creditors)</option>
          </select></label>
        )}
        <label>GSTIN<input value={f.gstin} onChange={(e) => setF({ ...f, gstin: e.target.value.toUpperCase() })} maxLength={15} placeholder="Leave empty if unregistered" /></label>
        <label>State {f.gstin ? '(from the GSTIN)' : ''}
          <select value={f.stateCode} onChange={set('stateCode')} disabled={Boolean(f.gstin)}>
            <option value="">—</option>
            {Object.entries(app.status.states).map(([k, v]) => <option key={k} value={k}>{k} {v}</option>)}
          </select>
        </label>
        <label>GST registration
          <select value={f.regType} onChange={set('regType')}>
            <option value="">{f.gstin ? 'Regular' : 'Unregistered'}</option>
            <option value="COMPOSITION">Composition dealer</option>
            <option value="SEZ">SEZ unit or developer (always IGST)</option>
            <option value="OVERSEAS">Overseas, import / export (always IGST)</option>
          </select>
        </label>
        <label>City<input value={f.city} onChange={set('city')} /></label>
        <label>Phone<input value={f.phone} onChange={set('phone')} /></label>
        <label>Credit days<input value={f.creditDays} onChange={set('creditDays')} inputMode="numeric" /></label>
        <ActiveToggle active={p.status !== 'INACTIVE'} busy={busy} label={p.name} onToggle={(on) => void save({ active: on }, on ? `${p.name} switched on` : `${p.name} switched off`)} />
        <p className="muted small span-2">The new name shows on every voucher already posted for this party.</p>
        <ErrorBox error={err} />
        <div className="form-actions"><button type="submit" className="primary" disabled={busy}>Save</button></div>
      </form>
    </Modal>
  );
}

export function EditLedger({ ledger: l, groups, onClose }: { ledger: Ledger; groups: Group[]; onClose: () => void }) {
  const [name, setName] = useState(l.name);
  const [groupId, setGroupId] = useState(l.groupId);
  const { err, busy, save } = useSave(`/ledgers/${l.id}`, onClose);
  const choices = groups.filter((g) => !['SUNDRY_DEBTORS', 'SUNDRY_CREDITORS'].includes(g.systemCode ?? ''));
  return (
    <Modal title={`Alter ledger: ${l.name}`} onClose={onClose}>
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); void save({ name, groupId }, `Saved ${name}`); }}>
        <label>Name<input value={name} onChange={(e) => setName(e.target.value)} required /></label>
        <label>Under group
          <select value={groupId} onChange={(e) => setGroupId(e.target.value)} disabled={Boolean(l.systemCode)}>
            {choices.map((g) => <option key={g.id} value={g.id}>{'· '.repeat(g.path.split('.').length - 1)}{g.name}</option>)}
          </select>
        </label>
        {l.systemCode && <p className="muted small span-2">A standard ledger: it can be renamed, but stays in its group.</p>}
        {!l.systemCode && <ActiveToggle active={l.isActive !== false} busy={busy} label={l.name} onToggle={(on) => void save({ active: on }, on ? `${l.name} switched on` : `${l.name} switched off`)} />}
        <ErrorBox error={err} />
        <div className="form-actions"><button type="submit" className="primary" disabled={busy}>Save</button></div>
      </form>
    </Modal>
  );
}

export function EditItem({ item: i, onClose }: { item: Item; onClose: () => void }) {
  const app = useApp();
  const [f, setF] = useState({
    name: i.name, uomId: i.uomId, hsnSac: i.hsnSac ?? '', gstRate: i.gstRatePpm === null ? '' : String(i.gstRatePpm / 10_000),
    valuation: i.valuation, allowNegative: Boolean(i.allowNegative),
  });
  const { err, busy, save } = useSave(`/items/${i.id}`, onClose);
  const moved = Number(i.qtyOnHand) !== 0;
  return (
    <Modal title={`Alter item: ${i.name}`} onClose={onClose}>
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); void save({ ...f, hsnSac: f.hsnSac || null, gstRate: f.gstRate || null }, `Saved ${f.name}`); }}>
        <label>Name<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></label>
        <label>Unit
          <select value={f.uomId} onChange={(e) => setF({ ...f, uomId: e.target.value })}>
            {app.masters.uoms.map((u) => <option key={u.id} value={u.id}>{u.symbol} ({u.uqc})</option>)}
          </select>
        </label>
        <label>HSN / SAC<input value={f.hsnSac} onChange={(e) => setF({ ...f, hsnSac: e.target.value })} inputMode="numeric" maxLength={8} /></label>
        <label>GST rate (%)
          <select value={f.gstRate} onChange={(e) => setF({ ...f, gstRate: e.target.value })}>
            <option value="">Not set</option>
            {['0', '0.25', '3', '5', '12', '18', '28', '40'].map((r) => <option key={r} value={r}>{r}%</option>)}
          </select>
        </label>
        <label>Valuation
          <select value={f.valuation} onChange={(e) => setF({ ...f, valuation: e.target.value })}>
            <option value="WAVG">Weighted average</option><option value="FIFO">FIFO</option>
          </select>
        </label>
        <label className="check"><input type="checkbox" checked={f.allowNegative} onChange={(e) => setF({ ...f, allowNegative: e.target.checked })} /> Allow selling more than is in stock</label>
        {moved && <p className="muted small span-2">Unit and valuation can change only before the item's first stock movement.</p>}
        <ActiveToggle active={i.isActive !== false} busy={busy} label={i.name} onToggle={(on) => void save({ active: on }, on ? `${i.name} switched on` : `${i.name} switched off`)} />
        <ErrorBox error={err} />
        <div className="form-actions"><button type="submit" className="primary" disabled={busy}>Save</button></div>
      </form>
    </Modal>
  );
}

export function EditGroup({ group: g, onClose }: { group: Group; onClose: () => void }) {
  const [name, setName] = useState(g.name);
  const { err, busy, save } = useSave(`/groups/${g.id}`, onClose);
  return (
    <Modal title={`Rename group: ${g.name}`} onClose={onClose}>
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); void save({ name }, `Renamed to ${name}`); }}>
        <label className="span-2">Name<input value={name} onChange={(e) => setName(e.target.value)} required /></label>
        <ErrorBox error={err} />
        <div className="form-actions"><button type="submit" className="primary" disabled={busy}>Save</button></div>
      </form>
    </Modal>
  );
}
