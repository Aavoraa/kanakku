import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, c, ApiError, type EntryLineInput, type ItemLineInput, type Posted, type Preview, type VoucherInput, type VoucherType } from '../api';
import { useApp } from '../state';
import { useKeys } from '../keys';
import { Picker, type Option } from '../components/Picker';
import { ItemForm, LedgerForm, PartyForm } from '../components/QuickCreate';
import { ErrorBox, Kbd, ScreenHead } from '../components/ui';
import { inr, multiplyAmount, pct, toMinor, fromMinor, TYPE_LABEL, uid } from '../format';

const TRADING: VoucherType[] = ['SALES', 'PURCHASE', 'CREDIT_NOTE', 'DEBIT_NOTE'];
const SWITCH: Record<string, VoucherType> = { F4: 'CONTRA', F5: 'PAYMENT', F6: 'RECEIPT', F7: 'JOURNAL', F8: 'SALES', F9: 'PURCHASE', 'Alt+F6': 'CREDIT_NOTE', 'Alt+F5': 'DEBIT_NOTE' };

interface ItemRow { key: string; ref: string | null; description: string; qty: string; rate: string; amount: string; gstRate: string; hsnSac: string; amountTouched: boolean }
interface EntryRow { key: string; side: 'DR' | 'CR'; ledgerId: string | null; amount: string; billRef: string }

const blankItem = (): ItemRow => ({ key: uid(), ref: null, description: '', qty: '', rate: '', amount: '', gstRate: '18', hsnSac: '', amountTouched: false });
const blankEntry = (side: 'DR' | 'CR'): EntryRow => ({ key: uid(), side, ledgerId: null, amount: '', billRef: '' });

function defaultEntries(t: VoucherType): EntryRow[] {
  // Tally order: the "particulars" side first, the cash/bank side second.
  if (t === 'RECEIPT') return [blankEntry('CR'), blankEntry('DR')];
  return [blankEntry('DR'), blankEntry('CR')];
}

export function VoucherEntry({ params }: { params?: { type?: VoucherType; input?: VoucherInput; alterOf?: string; alterNo?: string; docEntry?: { documentId: string; entryId: string; lineNo: number; note?: string } } }) {
  const app = useApp();
  const { masters, status } = app;
  const init = params?.input;
  const [type, setType] = useState<VoucherType>((init?.voucherType as VoucherType) ?? params?.type ?? 'SALES');
  const [date, setDate] = useState(init?.date ?? status.today);
  const [partyId, setPartyId] = useState<string | null>(init?.counterpartyId ?? null);
  const [mode, setMode] = useState<'CREDIT' | 'CASH' | 'BANK'>(init?.paymentMode ?? 'CREDIT');
  const [bankId, setBankId] = useState<string | null>(init?.bankLedgerId ?? null);
  const [refNo, setRefNo] = useState(init?.partyRefNo ?? '');
  const [refDate, setRefDate] = useState(init?.partyRefDate ?? '');
  const [originalRef, setOriginalRef] = useState(init?.originalRef ?? '');
  const [inclusive, setInclusive] = useState(init?.pricesIncludeTax ?? false);
  const [rcm, setRcm] = useState(init?.reverseCharge ?? false);
  const [narration, setNarration] = useState(init?.narration ?? '');
  const [items, setItems] = useState<ItemRow[]>(() => init?.items?.length ? init.items.map((i) => ({
    key: uid(), ref: i.itemId ? `item:${i.itemId}` : i.ledgerId ? `ledger:${i.ledgerId}` : null, description: i.description ?? '',
    qty: i.qty ?? '', rate: i.rate ?? '', amount: i.amount, gstRate: i.gstRate, hsnSac: i.hsnSac ?? '', amountTouched: true,
  })) : [blankItem()]);
  const [entries, setEntries] = useState<EntryRow[]>(() => init?.entries?.length ? init.entries.map((e) => ({
    key: uid(), side: e.side, ledgerId: e.ledgerId, amount: e.amount, billRef: e.billRef ?? '',
  })) : defaultEntries(params?.type ?? 'SALES'));
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<{ message: string; details?: unknown } | null>(null);
  const [pendingWarnings, setPendingWarnings] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState<{ kind: 'party' | 'ledger' | 'item'; name: string; apply: (id: string) => void } | null>(null);
  const idem = useRef(uid());
  const dateRef = useRef<HTMLInputElement>(null);
  const firstRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLDivElement>(null);
  const trading = TRADING.includes(type);
  const sales = type === 'SALES' || type === 'CREDIT_NOTE';

  // ---------- options ----------
  const partyOptions: Option[] = useMemo(() => masters.parties
    .filter((p) => (sales ? p.kind !== 'SUPPLIER' : p.kind !== 'CUSTOMER') || p.id === partyId)
    .map((p) => ({ id: p.id, label: p.name, sub: [p.city, p.gstin].filter(Boolean).join(' · '), right: inr(p.balanceMinor, { abs: true }) })), [masters.parties, sales, partyId]);
  const bankOptions: Option[] = useMemo(() => masters.ledgers.filter((l) => l.isCashBank && l.systemCode !== 'CASH').map((l) => ({ id: l.id, label: l.name, sub: l.groupName })), [masters.ledgers]);
  const lineOptions: Option[] = useMemo(() => [
    ...masters.items.map((i) => ({ id: `item:${i.id}`, label: i.name, sub: `${i.uom} · HSN ${i.hsnSac ?? '—'} · ${pct(i.gstRatePpm)}`, right: `${Number(i.qtyOnHand)} ${i.uom}` })),
    ...masters.ledgers.filter((l) => ['INCOME', 'EXPENSE'].includes(l.nature) || l.path.includes('fixed_assets'))
      .filter((l) => !l.taxComponent && l.systemCode !== 'ROUND_OFF')
      .map((l) => ({ id: `ledger:${l.id}`, label: l.name, sub: `Ledger · ${l.groupName}` })),
  ], [masters.items, masters.ledgers]);
  const ledgerOptions: Option[] = useMemo(() => masters.ledgers.filter((l) => !l.taxComponent).map((l) => ({
    id: l.id, label: l.name, sub: l.groupName, right: inr(l.balanceMinor, { abs: true }) + (BigInt(l.balanceMinor) > 0n ? ' Dr' : BigInt(l.balanceMinor) < 0n ? ' Cr' : ''),
  })), [masters.ledgers]);

  // ---------- build input ----------
  const buildInput = useCallback((confirmWarnings = false): VoucherInput | null => {
    const base = { voucherType: type, date, narration: narration || null, confirmWarnings };
    if (trading) {
      const lines: ItemLineInput[] = items.filter((r) => r.amount && toMinor(r.amount) !== null).map((r) => ({
        itemId: r.ref?.startsWith('item:') ? r.ref.slice(5) : null,
        ledgerId: r.ref?.startsWith('ledger:') ? r.ref.slice(7) : null,
        description: r.description || null, qty: r.qty || null, rate: r.rate || null,
        amount: r.amount, gstRate: r.gstRate || '0', hsnSac: r.hsnSac || null,
      }));
      if (!lines.length) return null;
      return {
        ...base, counterpartyId: partyId, paymentMode: mode, bankLedgerId: mode === 'BANK' ? bankId : null,
        partyRefNo: refNo || null, partyRefDate: refDate || null, originalRef: originalRef || null,
        pricesIncludeTax: inclusive, reverseCharge: type === 'PURCHASE' && rcm, items: lines,
      };
    }
    const lines: EntryLineInput[] = entries.filter((e) => e.ledgerId && e.amount && toMinor(e.amount)).map((e) => ({
      ledgerId: e.ledgerId!, side: e.side, amount: e.amount, billRef: e.billRef || null,
    }));
    if (lines.length < 2) return null;
    return { ...base, entries: lines };
  }, [type, date, narration, trading, items, partyId, mode, bankId, refNo, refDate, originalRef, inclusive, rcm, entries]);

  // A line with an amount that cannot be read ("55OO") would otherwise be left out of the voucher without a word.
  const badAmount = useMemo(() => {
    const rows = trading ? items : entries;
    const i = rows.findIndex((r) => r.amount.trim() !== '' && toMinor(r.amount) === null);
    return i < 0 ? null : `Line ${i + 1}: "${rows[i].amount}" is not an amount. Use digits only, like 5500 or 5500.50.`;
  }, [trading, items, entries]);

  // ---------- live preview ----------
  useEffect(() => {
    const input = buildInput(true);
    setPendingWarnings(null);
    if (badAmount) { setPreview(null); setError({ message: badAmount }); return; }
    if (!input || (trading && mode === 'CREDIT' && !partyId)) { setPreview(null); setError(null); return; }
    // Only the newest preview may land; an older, slower reply would show the wrong tax and total.
    let live = true;
    const t = setTimeout(async () => {
      try { const p = await api.post<Preview>(c('/vouchers/preview'), input); if (live) { setPreview(p); setError(null); } }
      catch (e) { if (live) { setPreview(null); setError(e instanceof ApiError ? { message: e.message, details: e.details } : { message: String(e) }); } }
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [buildInput, trading, mode, partyId, badAmount]);

  const entryDiff = useMemo(() => entries.reduce((s, e) => s + (toMinor(e.amount || '0') ?? 0n) * (e.side === 'DR' ? 1n : -1n), 0n), [entries]);

  const dirty = trading ? items.some((r) => r.amount || r.ref) || Boolean(partyId) : entries.some((e) => e.amount || e.ledgerId);

  const reset = (keepType = type) => {
    setPartyId(null); setRefNo(''); setRefDate(''); setOriginalRef(''); setNarration(''); setRcm(false);
    setItems([blankItem()]); setEntries(defaultEntries(keepType)); setPreview(null); setError(null); setPendingWarnings(null);
    idem.current = uid();
    setTimeout(() => firstRef.current?.focus(), 30);
  };

  const switchType = (t: VoucherType) => {
    if (params?.alterOf) return;
    setType(t);
    if (!TRADING.includes(t)) setEntries(defaultEntries(t));
    if (t === 'SALES' || t === 'PURCHASE') setMode('CREDIT');
    setPartyId(null);
    setTimeout(() => firstRef.current?.focus(), 30);
  };

  const post = async () => {
    if (busy) return;
    if (badAmount) { setError({ message: badAmount }); return; }
    const input = buildInput(pendingWarnings !== null);
    if (!input) { setError({ message: 'The voucher is incomplete.' }); return; }
    setBusy(true);
    try {
      let posted: Posted;
      if (params?.alterOf) {
        const r = await api.post<{ posted: Posted; reversal: Posted }>(c(`/vouchers/${params.alterOf}/alter`), input, { 'Idempotency-Key': idem.current });
        posted = r.posted;
        app.toast(`Altered: original reversed (${TYPE_LABEL[r.reversal.voucherType]} ${r.reversal.voucherNo}), new ${TYPE_LABEL[posted.voucherType]} ${posted.voucherNo} posted`);
        app.bumpData();
        app.back();
        return;
      }
      if (params?.docEntry) {
        // A line from an uploaded document: posting through the document marks the line done and learns from it.
        const { documentId, entryId, lineNo } = params.docEntry;
        const { confirmWarnings, ...payload } = input;
        posted = await api.post<Posted>(c(`/documents/${documentId}/entries/${entryId}/post`), { payload, confirmWarnings });
        app.toast(`Posted line ${lineNo} as ${TYPE_LABEL[posted.voucherType]} No. ${posted.voucherNo} · ₹${inr(posted.totalMinor)}`);
        app.bumpData();
        app.back();
        return;
      }
      posted = await api.post<Posted>(c('/vouchers'), input, { 'Idempotency-Key': idem.current });
      app.toast(posted.alreadyPosted ? `Already posted as ${TYPE_LABEL[posted.voucherType]} ${posted.voucherNo}` : `Posted ${TYPE_LABEL[posted.voucherType]} No. ${posted.voucherNo} · ₹${inr(posted.totalMinor)}`);
      app.bumpData();
      reset();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CONFIRM_WARNINGS') {
        const w = (e.details as { warnings: { message: string }[] }).warnings.map((x) => x.message);
        setPendingWarnings(w);
        setError(null);
      } else setError(e instanceof ApiError ? { message: e.message, details: e.details } : { message: String(e) });
    } finally { setBusy(false); }
  };

  const keymap: Record<string, () => boolean | void> = {
    'Ctrl+A': () => { void post(); },
    F2: () => { dateRef.current?.focus(); },
    Escape: () => {
      if (dirty && !window.confirm('Discard this voucher?')) return;
      app.back();
    },
  };
  keymap['Alt+N'] = () => { if (!trading) addEntry(); };
  for (const [k, t] of Object.entries(SWITCH)) keymap[k] = () => switchType(t);
  useKeys(keymap, !creating);

  // Enter moves to the next field (Tally style); Shift+Enter in narration for a new line.
  const onFormKey = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (e.key !== 'Enter' || t.tagName === 'TEXTAREA' || t.tagName === 'BUTTON' || e.ctrlKey) return;
    if (t.getAttribute('aria-expanded') === 'true' && (t as HTMLInputElement).value) return; // picker is selecting
    e.preventDefault();
    const fields = [...(formRef.current?.querySelectorAll<HTMLElement>('input:not([type=checkbox]),select,textarea') ?? [])].filter((x) => !x.hasAttribute('disabled'));
    const i = fields.indexOf(t);
    if (i >= 0 && i < fields.length - 1) fields[i + 1].focus();
  };

  const setItem = (key: string, patch: Partial<ItemRow>) => setItems((rows) => {
    const next = rows.map((r) => {
      if (r.key !== key) return r;
      const n = { ...r, ...patch };
      if (('qty' in patch || 'rate' in patch) && !n.amountTouched && n.qty && n.rate) {
        const amount = multiplyAmount(n.qty, n.rate);
        if (amount !== null) n.amount = amount;
      }
      return n;
    });
    const last = next[next.length - 1];
    if (last.amount || last.ref) next.push(blankItem());
    return next;
  });

  const pickLine = (key: string, ref: string | null) => {
    if (ref?.startsWith('item:')) {
      const it = masters.items.find((i) => `item:${i.id}` === ref);
      setItem(key, { ref, description: it?.name ?? '', gstRate: it?.gstRatePpm !== null && it?.gstRatePpm !== undefined ? String(it.gstRatePpm / 10_000) : '18', hsnSac: it?.hsnSac ?? '' });
    } else setItem(key, { ref });
  };

  const setEntry = (key: string, patch: Partial<EntryRow>) => setEntries((rows) => rows.map((r) => {
    if (r.key !== key) return r;
    const n = { ...r, ...patch };
    // Picking a ledger on an empty line fills in whatever balances the voucher (Tally behaviour).
    if ('ledgerId' in patch && !r.amount) {
      const diff = rows.filter((x) => x.key !== key).reduce((s, e) => s + (toMinor(e.amount || '0') ?? 0n) * (e.side === 'DR' ? 1n : -1n), 0n);
      if (diff !== 0n) { n.amount = fromMinor(diff > 0n ? diff : -diff); n.side = diff > 0n ? 'CR' : 'DR'; }
    }
    return n;
  }));
  const addEntry = () => setEntries((rows) => [...rows, blankEntry(entryDiff > 0n ? 'CR' : 'DR')]);

  const party = masters.parties.find((p) => p.id === partyId);
  const title = `${TYPE_LABEL[type]}${params?.alterOf ? ` · altering No. ${params.alterNo}` : ''}`;

  return (
    <div className="voucher" ref={formRef} onKeyDown={onFormKey}>
      <ScreenHead title={title} sub={<>No. <em>auto</em> · {trading ? (sales ? 'Outward supply' : 'Inward supply') : 'Accounting voucher'}</>}>
        <div className="type-switch" role="tablist" aria-label="Voucher type">
          {Object.entries(SWITCH).map(([k, t]) => (
            <button key={t} role="tab" aria-selected={t === type} className={t === type ? 'on' : ''} onClick={() => switchType(t)} disabled={Boolean(params?.alterOf) && t !== type}>
              <Kbd>{k}</Kbd> {TYPE_LABEL[t]}
            </button>
          ))}
        </div>
      </ScreenHead>
      {params?.docEntry && <div className="warn small">From an uploaded document, line {params.docEntry.lineNo}. Posting here completes that line.{params.docEntry.note ? ` ${params.docEntry.note}` : ''}</div>}

      <div className="voucher-body">
        <div className="voucher-main">
          <div className="field-row">
            <label className="w-date"><span>Date <Kbd>F2</Kbd></span><input ref={dateRef} type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
            {trading && (
              <>
                <label className="grow">{sales ? 'Party (customer)' : 'Party (supplier)'}
                  <Picker ref={firstRef} autoFocus options={partyOptions} value={partyId} onChange={setPartyId}
                    placeholder={mode === 'CREDIT' ? 'Type to search · Alt+C new' : 'Optional for cash'}
                    onCreate={(q) => setCreating({ kind: 'party', name: q, apply: setPartyId })} />
                </label>
                <label>Mode
                  <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
                    <option value="CREDIT">Credit</option><option value="CASH">Cash</option><option value="BANK">Bank</option>
                  </select>
                </label>
                {mode === 'BANK' && <label>Bank<Picker options={bankOptions} value={bankId} onChange={setBankId} placeholder="Bank account" /></label>}
              </>
            )}
          </div>
          {trading && (
            <div className="field-row">
              {(type === 'PURCHASE') && <>
                <label>Supplier invoice no.<input value={refNo} onChange={(e) => setRefNo(e.target.value)} maxLength={16} /></label>
                <label className="w-date">Invoice date<input type="date" value={refDate} onChange={(e) => setRefDate(e.target.value)} /></label>
              </>}
              {(type === 'CREDIT_NOTE' || type === 'DEBIT_NOTE') && <label>Against invoice no.<input value={originalRef} onChange={(e) => setOriginalRef(e.target.value)} /></label>}
              <label className="check"><input type="checkbox" checked={inclusive} onChange={(e) => setInclusive(e.target.checked)} /> Amounts include GST</label>
              {type === 'PURCHASE' && <label className="check"><input type="checkbox" checked={rcm} onChange={(e) => setRcm(e.target.checked)} /> Reverse charge</label>}
              {party && <span className="party-meta">{party.gstin ? `GSTIN ${party.gstin}` : 'Unregistered'} · {party.stateCode ? status.states[party.stateCode] : 'state unknown'} · balance {inr(party.balanceMinor, { abs: true })} {BigInt(party.balanceMinor) >= 0n ? 'Dr' : 'Cr'}</span>}
            </div>
          )}

          {trading ? (
            <table className="grid">
              <thead><tr><th>#</th><th>Item / ledger</th><th className="num">Qty</th><th className="num">Rate</th><th className="num">Amount ₹</th><th className="num">GST %</th><th></th></tr></thead>
              <tbody>
                {items.map((r, i) => {
                  const it = r.ref?.startsWith('item:') ? masters.items.find((x) => `item:${x.id}` === r.ref) : null;
                  return (
                    <tr key={r.key}>
                      <td className="muted">{i + 1}</td>
                      <td className="w-item"><Picker options={lineOptions} value={r.ref} onChange={(id) => pickLine(r.key, id)} placeholder="Item or ledger · Alt+C new item"
                        onCreate={(q) => setCreating({ kind: 'item', name: q, apply: (id) => pickLine(r.key, `item:${id}`) })} /></td>
                      <td className="w-num"><input className="num" value={r.qty} onChange={(e) => setItem(r.key, { qty: e.target.value })} inputMode="decimal" disabled={!it} placeholder={it ? it.uom : ''} /></td>
                      <td className="w-num"><input className="num" value={r.rate} onChange={(e) => setItem(r.key, { rate: e.target.value })} inputMode="decimal" /></td>
                      <td className="w-amt"><input className="num" value={r.amount} onChange={(e) => setItem(r.key, { amount: e.target.value, amountTouched: e.target.value !== '' })} inputMode="decimal" /></td>
                      <td className="w-rate"><input className="num" value={r.gstRate} onChange={(e) => setItem(r.key, { gstRate: e.target.value })} inputMode="decimal" /></td>
                      <td>{items.length > 1 && <button className="ghost" tabIndex={-1} aria-label="Remove line" onClick={() => setItems((rows) => rows.filter((x) => x.key !== r.key))}>×</button>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <table className="grid">
              <thead><tr><th>Dr/Cr</th><th>Ledger</th><th className="num">Amount ₹</th><th>Bill ref</th><th></th></tr></thead>
              <tbody>
                {entries.map((e, i) => {
                  const l = masters.ledgers.find((x) => x.id === e.ledgerId);
                  return (
                    <tr key={e.key}>
                      <td className="w-side">
                        <select value={e.side} onChange={(ev) => setEntry(e.key, { side: ev.target.value as 'DR' | 'CR' })} aria-label="Debit or credit">
                          <option value="DR">Dr</option><option value="CR">Cr</option>
                        </select>
                      </td>
                      <td className="w-item"><Picker ref={i === 0 ? firstRef : undefined} autoFocus={i === 0} options={ledgerOptions} value={e.ledgerId}
                        onChange={(id) => setEntry(e.key, { ledgerId: id })} placeholder="Ledger · Alt+C new"
                        onCreate={(q) => setCreating({ kind: 'ledger', name: q, apply: (id) => setEntry(e.key, { ledgerId: id }) })} /></td>
                      <td className="w-amt"><input className="num" value={e.amount} onChange={(ev) => setEntry(e.key, { amount: ev.target.value })} inputMode="decimal" /></td>
                      <td>{l?.billWise ? <BillRef ledgerId={l.id} value={e.billRef} onChange={(v) => setEntry(e.key, { billRef: v })} /> : <span className="muted">—</span>}</td>
                      <td>{entries.length > 2 && <button className="ghost" tabIndex={-1} aria-label="Remove line" onClick={() => setEntries((rows) => rows.filter((x) => x.key !== e.key))}>×</button>}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot><tr><td><button className="ghost" onClick={addEntry} title="Add line (Alt+N)">+ line</button></td><td className="muted">Difference</td><td className={`num ${entryDiff === 0n ? 'ok' : 'bad'}`}>{entryDiff === 0n ? 'balanced' : `${inr(entryDiff, { abs: true })} ${entryDiff > 0n ? 'Dr' : 'Cr'}`}</td><td colSpan={2}></td></tr></tfoot>
            </table>
          )}

          <label className="narration">Narration<textarea rows={2} value={narration} onChange={(e) => setNarration(e.target.value)} /></label>
          {!trading && <p className="muted small">Pick a party with bill-wise tracking to allocate against an open bill. Leave the bill ref empty to post on account.</p>}
          {trading && !partyId && mode === 'CREDIT' && <p className="muted small">Choose a party, or switch the mode to Cash for a counter sale.</p>}
        </div>

        <aside className="voucher-side" aria-live="polite">
          <h3>Posting preview</h3>
          {preview ? (
            <>
              <table className="mini">
                <tbody>
                  {preview.entries.map((e, i) => {
                    const v = BigInt(e.amountMinor);
                    return <tr key={i}><td>{e.ledgerName}{e.bill && <small> · {e.bill.type === 'NEW_REF' ? 'new bill' : e.bill.ref.replace('$VNO', 'this no.')}</small>}</td><td className="num">{v > 0n ? inr(v) : ''}</td><td className="num">{v < 0n ? inr(-v) : ''}</td></tr>;
                  })}
                </tbody>
                <tfoot><tr><td>Total</td><td className="num">{inr(preview.totalMinor)}</td><td className="num">{inr(preview.totalMinor)}</td></tr></tfoot>
              </table>
              {trading && <dl className="totals">
                <dt>Taxable</dt><dd className="num">{inr(preview.taxableMinor)}</dd>
                <dt>GST {preview.intraState === null ? '' : preview.intraState ? '(CGST + SGST)' : '(IGST)'}</dt><dd className="num">{inr(preview.taxMinor)}</dd>
                {preview.roundOffMinor !== '0' && <><dt>Round off</dt><dd className="num">{inr(preview.roundOffMinor)}</dd></>}
                <dt className="grand">Invoice total</dt><dd className="num grand">₹{inr(preview.totalMinor)}</dd>
                {preview.placeOfSupply && <><dt>Place of supply</dt><dd>{preview.placeOfSupply} {status.states[preview.placeOfSupply]}</dd></>}
              </dl>}
              {preview.warnings.map((w) => <div key={w.code} className="warn">{w.message}</div>)}
            </>
          ) : <p className="muted">Entries appear here as you type. Debits, credits and tax are worked out by the posting rules.</p>}
          {pendingWarnings && (
            <div className="warn strong" role="alert">
              {pendingWarnings.map((w) => <div key={w}>{w}</div>)}
              <div>Press <Kbd>Ctrl+A</Kbd> again to post anyway.</div>
            </div>
          )}
          <ErrorBox error={error} />
          <button className="primary post" onClick={() => void post()} disabled={busy}>
            {params?.alterOf ? 'Reverse original & post' : 'Post voucher'} <Kbd>Ctrl+A</Kbd>
          </button>
        </aside>
      </div>

      {creating?.kind === 'party' && <PartyForm initialName={creating.name} kind={sales ? 'CUSTOMER' : 'SUPPLIER'} onClose={() => setCreating(null)} onDone={(id) => { creating.apply(id); setCreating(null); }} />}
      {creating?.kind === 'ledger' && <LedgerForm initialName={creating.name} onClose={() => setCreating(null)} onDone={(id) => { creating.apply(id); setCreating(null); }} />}
      {creating?.kind === 'item' && <ItemForm initialName={creating.name} onClose={() => setCreating(null)} onDone={(id) => { creating.apply(id); setCreating(null); }} />}
    </div>
  );
}

function BillRef({ ledgerId, value, onChange }: { ledgerId: string; value: string; onChange: (v: string) => void }) {
  const [bills, setBills] = useState<{ billRef: string; billDate: string; openMinor: string }[]>([]);
  useEffect(() => { void api.get<typeof bills>(c(`/bills/open?ledgerId=${ledgerId}`)).then(setBills).catch(() => setBills([])); }, [ledgerId]);
  const id = `bills-${ledgerId}`;
  return (
    <>
      <input list={id} value={value} onChange={(e) => onChange(e.target.value)} placeholder={bills.length ? `${bills.length} open · on account if blank` : 'On account'} />
      <datalist id={id}>{bills.map((b) => <option key={b.billRef} value={b.billRef}>{`${b.billDate} · ₹${inr(b.openMinor, { abs: true })}`}</option>)}</datalist>
    </>
  );
}
