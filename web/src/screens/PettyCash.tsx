import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, c, ApiError, type Posted } from '../api';
import { useApp } from '../state';
import { Picker, type Option } from '../components/Picker';
import { Empty, ErrorBox, ScreenHead } from '../components/ui';
import { fmtDate, fromMinor, inr, toMinor, todayIST, TYPE_LABEL, uid } from '../format';

interface Box {
  id: string; ledgerId: string; name: string; custodian: string | null; floatMinor: string; voucherLimitMinor: string;
  balanceMinor: string; topUpMinor: string; low: boolean; lastCount: string | null; lastCountDiffMinor: string | null;
}
interface Book {
  openingMinor: string; closingMinor: string; totalDebitMinor: string; totalCreditMinor: string;
  lines: { voucherId: string; date: string; voucherNo: string; voucherType: string; amountMinor: string; particulars: string | null; narration: string | null; balanceMinor: string }[];
  byHead: { ledger: string; amountMinor: string }[];
  counts: { id: string; date: string; countedMinor: string; bookMinor: string; differenceMinor: string; adjustmentNo: string | null; remarks: string | null }[];
}
type Err = { message: string; details?: unknown } | null;
const asErr = (e: unknown): Err => (e instanceof ApiError ? { message: e.message, details: e.details } : { message: String(e) });
type Tab = 'expense' | 'topup' | 'count' | 'settings';

/** Petty cash on the imprest system: pay small expenses, top up to the float, count the cash, see the book. */
export function PettyCash() {
  const app = useApp();
  const [boxes, setBoxes] = useState<Box[] | null>(null);
  const [denoms, setDenoms] = useState<number[]>([]);
  const [boxId, setBoxId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('expense');
  const [adding, setAdding] = useState(false);
  const load = useCallback(async () => {
    const r = await api.get<{ boxes: Box[]; denominations: number[] }>(c('/petty-cash'));
    setBoxes(r.boxes); setDenoms(r.denominations);
    setBoxId((id) => (id && r.boxes.some((b) => b.id === id) ? id : r.boxes[0]?.id ?? null));
  }, []);
  useEffect(() => { void load(); }, [load, app.dataVersion]);
  const box = boxes?.find((b) => b.id === boxId) ?? null;
  const changed = async () => { await load(); app.bumpData(); };

  if (!boxes) return <p className="muted">Loading…</p>;
  if (!boxes.length || adding) {
    return (
      <div className="settings">
        <ScreenHead title="Set up petty cash" sub="Imprest system: a fixed float kept by a custodian, topped up back to the float after spending." />
        <SetupBox onDone={async () => { setAdding(false); await changed(); }} onCancel={boxes.length ? () => setAdding(false) : undefined} />
      </div>
    );
  }
  if (!box) return null;
  const spent = BigInt(box.floatMinor) - BigInt(box.balanceMinor);
  return (
    <div className="petty">
      <ScreenHead title={box.name} sub={`Imprest petty cash${box.custodian ? ` · kept by ${box.custodian}` : ''} · limit ₹${inr(box.voucherLimitMinor)} per payment`}>
        {boxes.length > 1 && (
          <select value={box.id} onChange={(e) => setBoxId(e.target.value)} aria-label="Petty cash box">
            {boxes.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        )}
        <button onClick={() => setAdding(true)}>Add another box</button>
      </ScreenHead>
      <section className="tiles" aria-label="Petty cash">
        <div className={`tile ${box.low ? 'tile-warn' : ''}`}><span className="tile-label">Cash in the box (books)</span><span className="tile-value num">₹{inr(box.balanceMinor)}</span>
          {box.low && <span className="tile-note bad">Low: top it up</span>}</div>
        <div className="tile"><span className="tile-label">Float</span><span className="tile-value num">₹{inr(box.floatMinor)}</span></div>
        <div className="tile"><span className="tile-label">Spent since last top-up</span><span className="tile-value num">₹{inr(spent > 0n ? spent : 0n)}</span></div>
        <div className="tile"><span className="tile-label">Last counted</span><span className="tile-value">{box.lastCount ? fmtDate(box.lastCount) : '—'}</span>
          {box.lastCountDiffMinor && BigInt(box.lastCountDiffMinor) !== 0n && <span className="tile-note">{BigInt(box.lastCountDiffMinor) < 0n ? 'short' : 'excess'} ₹{inr(box.lastCountDiffMinor, { abs: true })}</span>}</div>
      </section>
      <div className="tabs" role="tablist">
        {([['expense', 'Pay an expense'], ['topup', 'Top up'], ['count', 'Count cash'], ['settings', 'Box settings']] as [Tab, string][]).map(([t, label]) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{label}</button>
        ))}
      </div>
      <div className="petty-panel">
        {tab === 'expense' && <ExpenseForm box={box} onDone={changed} />}
        {tab === 'topup' && <TopUpForm box={box} onDone={changed} />}
        {tab === 'count' && <CountForm box={box} denoms={denoms} onDone={changed} />}
        {tab === 'settings' && <BoxSettings box={box} onDone={changed} />}
      </div>
      <PettyBook box={box} />
    </div>
  );
}

const cashBankOptions = (ledgers: ReturnType<typeof useApp>['masters']['ledgers'], exclude: string) =>
  ledgers.filter((l) => l.isCashBank && l.id !== exclude).map((l) => <option key={l.id} value={l.id}>{l.name}</option>);

function SetupBox({ onDone, onCancel }: { onDone: () => Promise<void>; onCancel?: () => void }) {
  const app = useApp();
  const [f, setF] = useState({ name: 'Petty Cash', custodian: '', floatAmount: '10000', voucherLimit: '5000', fundFromLedgerId: '', date: app.status.today });
  const [err, setErr] = useState<Err>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    try { await api.post(c('/petty-cash'), { ...f, fundFromLedgerId: f.fundFromLedgerId || null }); app.toast(`${f.name} is set up`); await onDone(); } catch (e) { setErr(asErr(e)); }
  };
  return (
    <form className="form-grid narrow" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <label>Name<input value={f.name} onChange={set('name')} required /></label>
      <label>Kept by (custodian)<input value={f.custodian} onChange={set('custodian')} placeholder="e.g. Ravi, office manager" /></label>
      <label>Float (₹)<input value={f.floatAmount} onChange={set('floatAmount')} inputMode="decimal" required /></label>
      <label>Limit per payment (₹)<input value={f.voucherLimit} onChange={set('voucherLimit')} inputMode="decimal" required /></label>
      <label>Hand over the float now from
        <select value={f.fundFromLedgerId} onChange={set('fundFromLedgerId')}><option value="">Not now</option>{cashBankOptions(app.masters.ledgers, '')}</select>
      </label>
      {f.fundFromLedgerId && <label>On<input type="date" value={f.date} onChange={set('date')} /></label>}
      <p className="muted small span-2">This creates a ledger under Cash-in-Hand. Payments above the limit ask for confirmation; the bell reminds you to top up when
        the cash falls below a quarter of the float.</p>
      <ErrorBox error={err} />
      <div className="form-actions">{onCancel && <button type="button" onClick={onCancel}>Cancel</button>}<button className="primary" type="submit">Set up</button></div>
    </form>
  );
}

function ExpenseForm({ box, onDone }: { box: Box; onDone: () => Promise<void> }) {
  const app = useApp();
  const blank = { date: app.status.today, expenseLedgerId: null as string | null, amount: '', gstRate: '0', billNo: '', paidTo: '', narration: '' };
  const [f, setF] = useState(blank);
  const [key, setKey] = useState(uid);
  const [warnings, setWarnings] = useState<string[] | null>(null);
  const [err, setErr] = useState<Err>(null);
  const [busy, setBusy] = useState(false);
  const heads: Option[] = useMemo(() => app.masters.ledgers
    .filter((l) => !l.taxComponent && !l.isCashBank && !l.counterpartyId && (l.nature === 'EXPENSE' || l.path.includes('fixed_assets')))
    .map((l) => ({ id: l.id, label: l.name, sub: l.groupName })), [app.masters.ledgers]);
  const amount = toMinor(f.amount || '0');
  const post = async (confirm: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      const p = await api.post<Posted>(c(`/petty-cash/${box.id}/expenses`), { ...f, confirmWarnings: confirm }, { 'Idempotency-Key': key });
      app.toast(`${TYPE_LABEL[p.voucherType]} No. ${p.voucherNo} · ₹${inr(p.totalMinor)} paid from ${box.name}`);
      setF({ ...blank, date: f.date }); setKey(uid()); setWarnings(null); setErr(null);
      await onDone();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CONFIRM_WARNINGS') { setWarnings((e.details as { warnings: { message: string }[] }).warnings.map((w) => w.message)); setErr(null); }
      else setErr(asErr(e));
    } finally { setBusy(false); }
  };
  return (
    <form className="form-grid narrow" onSubmit={(e) => { e.preventDefault(); void post(warnings !== null); }}>
      <label>Date<input type="date" value={f.date} max={app.status.today} onChange={(e) => { setF({ ...f, date: e.target.value }); setWarnings(null); }} required /></label>
      <label>Expense head<Picker options={heads} value={f.expenseLedgerId} onChange={(id) => setF({ ...f, expenseLedgerId: id })} placeholder="e.g. Office Expenses, Conveyance" ariaLabel="Expense head" /></label>
      <label>Amount paid (₹, bill total)<input value={f.amount} onChange={(e) => { setF({ ...f, amount: e.target.value }); setWarnings(null); }} inputMode="decimal" required /></label>
      <label>GST on the bill
        <select value={f.gstRate} onChange={(e) => setF({ ...f, gstRate: e.target.value })}>
          <option value="0">No GST (or unregistered seller)</option>{['5', '12', '18', '28'].map((r) => <option key={r} value={r}>{r}% included in the amount</option>)}
        </select>
      </label>
      <label>Paid to<input value={f.paidTo} onChange={(e) => setF({ ...f, paidTo: e.target.value })} placeholder="Shop or person" /></label>
      <label>Bill / voucher no.<input value={f.billNo} onChange={(e) => setF({ ...f, billNo: e.target.value })} maxLength={16} /></label>
      <label className="span-2">Narration<input value={f.narration} onChange={(e) => setF({ ...f, narration: e.target.value })} /></label>
      {amount !== null && amount > BigInt(box.balanceMinor) && <p className="warn small span-2">More than the ₹{inr(box.balanceMinor)} in the box: top it up first.</p>}
      {warnings && <div className="warn span-2">{warnings.map((w) => <p key={w} className="small">{w}</p>)}</div>}
      <ErrorBox error={err} />
      <div className="form-actions">
        <button className="primary" type="submit" disabled={busy || !f.expenseLedgerId}>{warnings ? 'Pay anyway' : 'Pay from petty cash'}</button>
      </div>
    </form>
  );
}

function TopUpForm({ box, onDone }: { box: Box; onDone: () => Promise<void> }) {
  const app = useApp();
  const [fromLedgerId, setFrom] = useState(app.masters.ledgers.find((l) => l.isCashBank && l.systemCode !== 'CASH' && l.id !== box.ledgerId)?.id ?? '');
  const [date, setDate] = useState(app.status.today);
  const [amount, setAmount] = useState(BigInt(box.topUpMinor) > 0n ? fromMinor(BigInt(box.topUpMinor)) : '');
  const [key, setKey] = useState(uid);
  const [err, setErr] = useState<Err>(null);
  const save = async () => {
    try {
      const p = await api.post<Posted>(c(`/petty-cash/${box.id}/top-up`), { fromLedgerId, date, amount: amount || null }, { 'Idempotency-Key': key });
      app.toast(`Topped up ₹${inr(p.totalMinor)} (Contra No. ${p.voucherNo})`); setKey(uid()); setErr(null); await onDone();
    } catch (e) { setErr(asErr(e)); }
  };
  return (
    <form className="form-grid narrow" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <label>From<select value={fromLedgerId} onChange={(e) => setFrom(e.target.value)} required><option value="">Choose bank or cash</option>{cashBankOptions(app.masters.ledgers, box.ledgerId)}</select></label>
      <label>Date<input type="date" value={date} max={app.status.today} onChange={(e) => setDate(e.target.value)} /></label>
      <label>Amount (₹)<input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="Back up to the float" /></label>
      <p className="muted small span-2">Imprest: the top-up equals what was spent since the last one (₹{inr(box.topUpMinor)} now), bringing the box back to ₹{inr(box.floatMinor)}.</p>
      <ErrorBox error={err} />
      <div className="form-actions"><button className="primary" type="submit" disabled={!fromLedgerId}>Top up</button></div>
    </form>
  );
}

function CountForm({ box, denoms, onDone }: { box: Box; denoms: number[]; onDone: () => Promise<void> }) {
  const app = useApp();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [coins, setCoins] = useState('');
  const [date, setDate] = useState(app.status.today);
  const [remarks, setRemarks] = useState('');
  const [post, setPost] = useState(true);
  const [key, setKey] = useState(uid);
  const [err, setErr] = useState<Err>(null);
  const [result, setResult] = useState<{ countedMinor: string; bookMinor: string; differenceMinor: string; adjustment: Posted | null } | null>(null);
  const counted = denoms.reduce((s, d) => s + BigInt(d) * 100n * BigInt(Number(notes[d] || 0) || 0), 0n) + (toMinor(coins || '0') ?? 0n);
  const diff = date === app.status.today ? counted - BigInt(box.balanceMinor) : null;
  const save = async () => {
    try {
      const r = await api.post<typeof result>(c(`/petty-cash/${box.id}/counts`), { date, notes, coins: coins || null, remarks, postDifference: post }, { 'Idempotency-Key': key });
      setResult(r); setKey(uid()); setNotes({}); setCoins(''); setRemarks(''); setErr(null);
      await onDone();
    } catch (e) { setErr(asErr(e)); }
  };
  return (
    <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <table className="list count-grid">
        <thead><tr><th>Note / coin</th><th className="num">How many</th><th className="num">₹</th></tr></thead>
        <tbody>
          {denoms.map((d) => (
            <tr key={d}><td>₹{d}</td>
              <td className="num"><input value={notes[d] ?? ''} onChange={(e) => setNotes({ ...notes, [d]: e.target.value.replace(/\D/g, '') })} inputMode="numeric" aria-label={`Number of ₹${d}`} /></td>
              <td className="num">{notes[d] ? inr(BigInt(d) * 100n * BigInt(Number(notes[d]))) : ''}</td></tr>
          ))}
          <tr><td>Loose coins (₹)</td><td className="num"><input value={coins} onChange={(e) => setCoins(e.target.value)} inputMode="decimal" aria-label="Loose coins" /></td><td className="num">{coins ? inr(toMinor(coins) ?? 0n) : ''}</td></tr>
        </tbody>
        <tfoot>
          <tr><td colSpan={2}>Counted</td><td className="num">{inr(counted)}</td></tr>
          {diff !== null && <tr><td colSpan={2}>Books say</td><td className="num">{inr(box.balanceMinor)}</td></tr>}
          {diff !== null && diff !== 0n && <tr className="bad"><td colSpan={2}>{diff < 0n ? 'Short' : 'Excess'}</td><td className="num">{inr(diff, { abs: true })}</td></tr>}
        </tfoot>
      </table>
      <div className="inline-form">
        <label>Counted on<input type="date" value={date} max={app.status.today} onChange={(e) => setDate(e.target.value)} /></label>
        <label className="grow">Remarks<input value={remarks} onChange={(e) => setRemarks(e.target.value)} /></label>
        <label className="check"><input type="checkbox" checked={post} onChange={(e) => setPost(e.target.checked)} /> Post any shortage or excess to “Petty Cash Short / Excess”</label>
        <button className="primary" type="submit">Save count</button>
      </div>
      <ErrorBox error={err} />
      {result && (
        <p className={BigInt(result.differenceMinor) === 0n ? 'ok' : 'warn'}>
          {BigInt(result.differenceMinor) === 0n ? `Cash agrees with the books: ₹${inr(result.countedMinor)}.`
            : `${BigInt(result.differenceMinor) < 0n ? 'Short' : 'Excess'} by ₹${inr(result.differenceMinor, { abs: true })}${result.adjustment ? `; posted as ${TYPE_LABEL[result.adjustment.voucherType]} No. ${result.adjustment.voucherNo}` : '; not posted'}.`}
        </p>
      )}
    </form>
  );
}

function BoxSettings({ box, onDone }: { box: Box; onDone: () => Promise<void> }) {
  const app = useApp();
  const [custodian, setCustodian] = useState(box.custodian ?? '');
  const [floatAmount, setFloat] = useState(fromMinor(BigInt(box.floatMinor)));
  const [voucherLimit, setLimit] = useState(fromMinor(BigInt(box.voucherLimitMinor)));
  const [err, setErr] = useState<Err>(null);
  const save = async () => {
    try { await api.patch(c(`/petty-cash/${box.id}`), { custodian, floatAmount, voucherLimit }); app.toast('Saved'); setErr(null); await onDone(); } catch (e) { setErr(asErr(e)); }
  };
  return (
    <form className="form-grid narrow" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <label>Kept by (custodian)<input value={custodian} onChange={(e) => setCustodian(e.target.value)} /></label>
      <label>Float (₹)<input value={floatAmount} onChange={(e) => setFloat(e.target.value)} inputMode="decimal" /></label>
      <label>Limit per payment (₹)<input value={voucherLimit} onChange={(e) => setLimit(e.target.value)} inputMode="decimal" /></label>
      <p className="muted small span-2">To rename the box, alter its ledger in Masters → Ledgers.</p>
      <ErrorBox error={err} />
      <div className="form-actions"><button className="primary" type="submit">Save</button></div>
    </form>
  );
}

function PettyBook({ box }: { box: Box }) {
  const app = useApp();
  const [to, setTo] = useState(app.status.today);
  const [from, setFrom] = useState(`${app.status.today.slice(0, 8)}01`);
  const [book, setBook] = useState<Book | null>(null);
  useEffect(() => {
    let live = true;
    void api.get<Book>(c(`/petty-cash/${box.id}/book?from=${from}&to=${to}`)).then((b) => { if (live) setBook(b); }).catch(() => {});
    return () => { live = false; };
  }, [box.id, from, to, app.dataVersion]);
  return (
    <section>
      <div className="screen-head">
        <h2>Petty cash book</h2>
        <div className="head-actions">
          <label>From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label>To<input type="date" value={to} max={todayIST()} onChange={(e) => setTo(e.target.value)} /></label>
        </div>
      </div>
      {!book ? <p className="muted">Loading…</p> : <>
        <table className="list selectable">
          <thead><tr><th>Date</th><th>Type</th><th>No.</th><th>Particulars</th><th className="num">Received ₹</th><th className="num">Paid ₹</th><th className="num">Balance ₹</th></tr></thead>
          <tbody>
            <tr className="muted"><td colSpan={6}>Opening balance</td><td className="num">{inr(book.openingMinor)}</td></tr>
            {book.lines.map((l, i) => (
              <tr key={i} tabIndex={0} onClick={() => app.go({ screen: 'voucher-view', params: { id: l.voucherId } })}
                onKeyDown={(e) => { if (e.key === 'Enter') app.go({ screen: 'voucher-view', params: { id: l.voucherId } }); }}>
                <td>{fmtDate(l.date)}</td><td>{TYPE_LABEL[l.voucherType]}</td><td>{l.voucherNo}</td>
                <td>{l.particulars}{l.narration && <div className="muted small">{l.narration}</div>}</td>
                <td className="num">{BigInt(l.amountMinor) > 0n ? inr(l.amountMinor) : ''}</td>
                <td className="num">{BigInt(l.amountMinor) < 0n ? inr(l.amountMinor, { abs: true }) : ''}</td>
                <td className="num">{inr(l.balanceMinor)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot><tr><td colSpan={4}>Closing balance</td><td className="num">{inr(book.totalDebitMinor)}</td><td className="num">{inr(book.totalCreditMinor)}</td><td className="num">{inr(book.closingMinor)}</td></tr></tfoot>
        </table>
        {book.lines.length === 0 && <Empty>No petty cash movements in this period.</Empty>}
        {book.byHead.length > 0 && <>
          <h3>Spent on</h3>
          <table className="list"><tbody>{book.byHead.map((h) => <tr key={h.ledger}><td>{h.ledger}</td><td className="num">{inr(h.amountMinor)}</td></tr>)}</tbody></table>
        </>}
        {book.counts.length > 0 && <>
          <h3>Cash counts</h3>
          <table className="list">
            <thead><tr><th>Date</th><th className="num">Counted ₹</th><th className="num">Books ₹</th><th className="num">Difference ₹</th><th>Posted as</th><th>Remarks</th></tr></thead>
            <tbody>{book.counts.map((k) => (
              <tr key={k.id}><td>{fmtDate(k.date)}</td><td className="num">{inr(k.countedMinor)}</td><td className="num">{inr(k.bookMinor)}</td>
                <td className={`num ${BigInt(k.differenceMinor) !== 0n ? 'bad' : ''}`}>{BigInt(k.differenceMinor) === 0n ? 'agrees' : inr(k.differenceMinor)}</td>
                <td>{k.adjustmentNo ?? ''}</td><td>{k.remarks}</td></tr>
            ))}</tbody>
          </table>
        </>}
      </>}
    </section>
  );
}
