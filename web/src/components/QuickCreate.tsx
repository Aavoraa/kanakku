import { useState } from 'react';
import { api, c, ApiError } from '../api';
import { useApp } from '../state';
import { ErrorBox, Modal } from './ui';

type Err = { message: string; details?: unknown } | null;
const asErr = (e: unknown): Err => (e instanceof ApiError ? { message: e.message, details: e.details } : { message: String(e) });

export function PartyForm({ initialName = '', kind: initialKind = 'CUSTOMER', onDone, onClose }: {
  initialName?: string; kind?: 'CUSTOMER' | 'SUPPLIER'; onDone: (id: string) => void; onClose: () => void;
}) {
  const { status, refreshMasters, toast } = useApp();
  const [f, setF] = useState({ name: initialName, kind: initialKind, gstin: '', stateCode: '', city: '', phone: '', creditDays: '', openingBalance: '', regType: '' });
  const [err, setErr] = useState<Err>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    try {
      const r = await api.post<{ id: string }>(c('/parties'), {
        ...f, gstin: f.gstin || null, stateCode: f.stateCode || null, creditDays: f.creditDays ? Number(f.creditDays) : null,
        openingBalance: f.openingBalance || null, regType: f.regType || null,
      });
      await refreshMasters();
      toast(`Created ${f.name}`);
      onDone(r.id);
    } catch (e) { setErr(asErr(e)); }
  };
  return (
    <Modal title="New party" onClose={onClose}>
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <label>Name<input value={f.name} onChange={set('name')} required /></label>
        <label>Type
          <select value={f.kind} onChange={set('kind')}>
            <option value="CUSTOMER">Customer (Sundry Debtors)</option>
            <option value="SUPPLIER">Supplier (Sundry Creditors)</option>
          </select>
        </label>
        <label>GSTIN<input value={f.gstin} onChange={(e) => setF({ ...f, gstin: e.target.value.toUpperCase() })} maxLength={15} placeholder="Optional" /></label>
        <label>State (if no GSTIN)
          <select value={f.stateCode} onChange={set('stateCode')}>
            <option value="">—</option>
            {Object.entries(status.states).map(([k, v]) => <option key={k} value={k}>{k} {v}</option>)}
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
        <label>Opening balance (₹)<input value={f.openingBalance} onChange={set('openingBalance')} inputMode="decimal" placeholder={f.kind === 'CUSTOMER' ? 'they owe you' : 'you owe them'} /></label>
        <ErrorBox error={err} />
        <div className="form-actions"><button type="submit" className="primary">Create party</button></div>
      </form>
    </Modal>
  );
}

export function LedgerForm({ initialName = '', onDone, onClose }: { initialName?: string; onDone: (id: string) => void; onClose: () => void }) {
  const { masters, refreshMasters, toast } = useApp();
  const groups = masters.groups.filter((g) => !['SUNDRY_DEBTORS', 'SUNDRY_CREDITORS'].includes(g.systemCode ?? ''));
  const [f, setF] = useState({ name: initialName, groupId: groups.find((g) => g.systemCode === 'INDIRECT_EXPENSES')?.id ?? '', openingBalance: '', openingSide: 'DR' });
  const [err, setErr] = useState<Err>(null);
  const save = async () => {
    try {
      const r = await api.post<{ id: string }>(c('/ledgers'), { ...f, openingBalance: f.openingBalance || null });
      await refreshMasters();
      toast(`Created ledger ${f.name}`);
      onDone(r.id);
    } catch (e) { setErr(asErr(e)); }
  };
  return (
    <Modal title="New ledger" onClose={onClose}>
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <label>Name<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></label>
        <label>Under group
          <select value={f.groupId} onChange={(e) => setF({ ...f, groupId: e.target.value })}>
            {groups.map((g) => <option key={g.id} value={g.id}>{'· '.repeat(g.path.split('.').length - 1)}{g.name}</option>)}
          </select>
        </label>
        <label>Opening balance (₹)<input value={f.openingBalance} onChange={(e) => setF({ ...f, openingBalance: e.target.value })} inputMode="decimal" /></label>
        <label>Side
          <select value={f.openingSide} onChange={(e) => setF({ ...f, openingSide: e.target.value })}>
            <option value="DR">Dr</option><option value="CR">Cr</option>
          </select>
        </label>
        <ErrorBox error={err} />
        <div className="form-actions"><button type="submit" className="primary">Create ledger</button></div>
      </form>
    </Modal>
  );
}

export function ItemForm({ initialName = '', onDone, onClose }: { initialName?: string; onDone: (id: string) => void; onClose: () => void }) {
  const { masters, refreshMasters, toast } = useApp();
  const [f, setF] = useState({ name: initialName, uomId: masters.uoms.find((u) => u.symbol === 'Nos')?.id ?? masters.uoms[0]?.id ?? '', hsnSac: '', gstRate: '18', valuation: 'WAVG' });
  const [err, setErr] = useState<Err>(null);
  const save = async () => {
    try {
      const r = await api.post<{ id: string }>(c('/items'), { ...f, hsnSac: f.hsnSac || null });
      await refreshMasters();
      toast(`Created item ${f.name}`);
      onDone(r.id);
    } catch (e) { setErr(asErr(e)); }
  };
  return (
    <Modal title="New stock item" onClose={onClose}>
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <label>Name<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></label>
        <label>Unit
          <select value={f.uomId} onChange={(e) => setF({ ...f, uomId: e.target.value })}>
            {masters.uoms.map((u) => <option key={u.id} value={u.id}>{u.symbol} ({u.uqc})</option>)}
          </select>
        </label>
        <label>HSN / SAC<input value={f.hsnSac} onChange={(e) => setF({ ...f, hsnSac: e.target.value })} inputMode="numeric" maxLength={8} /></label>
        <label>GST rate (%)
          <select value={f.gstRate} onChange={(e) => setF({ ...f, gstRate: e.target.value })}>
            {['0', '0.25', '3', '5', '12', '18', '28', '40'].map((r) => <option key={r} value={r}>{r}%</option>)}
          </select>
        </label>
        <label>Valuation
          <select value={f.valuation} onChange={(e) => setF({ ...f, valuation: e.target.value })}>
            <option value="WAVG">Weighted average</option><option value="FIFO">FIFO</option>
          </select>
        </label>
        <ErrorBox error={err} />
        <div className="form-actions"><button type="submit" className="primary">Create item</button></div>
      </form>
    </Modal>
  );
}
