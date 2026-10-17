import { useEffect, useState } from 'react';
import { api, c, ApiError, type VoucherInput } from '../api';
import { useApp } from '../state';
import { useKeys } from '../keys';
import { ErrorBox, Kbd, ScreenHead } from '../components/ui';
import { fmtDate, inr, pct, TYPE_LABEL } from '../format';

interface Detail {
  id: string; voucherNo: string; date: string; voucherType: string; typeName: string; totalMinor: string; source: string;
  narration: string | null; partyRefNo: string | null; partyRefDate: string | null; originalRef: string | null; placeOfSupply: string | null;
  reverseCharge: boolean; paymentMode: string | null; partyName: string | null; partyGstin: string | null;
  reversesVoucherId: string | null; reversesNo: string | null; reversedById: string | null; reversedByNo: string | null;
  chainSeq: string; rowHash: string; postedAt: string; input: VoucherInput | null;
  entries: { lineNo: number; ledgerId: string; ledgerName: string; amountMinor: string; billRef: string | null; billType: string | null; dueDate: string | null }[];
  taxes: { itemLineNo: number; hsnSac: string | null; component: string; ratePpm: number; taxableMinor: string; taxMinor: string; direction: string; reverseCharge: boolean; itcEligible: boolean }[];
  inventory: { lineNo: number; itemName: string; uom: string; qty: string; unitCost: string | null; godown: string }[];
}

export function VoucherView({ params }: { params: { id: string } }) {
  const app = useApp();
  const [v, setV] = useState<Detail | null>(null);
  const [error, setError] = useState<{ message: string } | null>(null);
  useEffect(() => { void api.get<Detail>(c(`/vouchers/${params.id}`)).then(setV).catch((e) => setError({ message: String(e.message) })); }, [params.id, app.dataVersion]);

  const canChange = v && !v.reversesVoucherId && !v.reversedById && v.voucherType !== 'OPENING';
  // A sale or purchase in a closed (locked) period is corrected with a credit / debit note dated today, not reversed.
  const closedInvoice = Boolean(v && app.company.lockDate && v.date <= app.company.lockDate
    && ['SALES', 'PURCHASE', 'CREDIT_NOTE', 'DEBIT_NOTE'].includes(v.voucherType));
  const noteName = v?.voucherType === 'SALES' ? 'credit note' : v?.voucherType === 'PURCHASE' ? 'debit note' : v?.voucherType === 'CREDIT_NOTE' ? 'sales invoice' : 'purchase';
  const offerNote = async () => {
    if (!v) return;
    if (!window.confirm(`${v.typeName} No. ${v.voucherNo} is in a closed period (books locked up to ${app.company.lockDate}), so it cannot be reversed or altered. `
      + `Prepare a ${noteName} dated today against it instead? You can check and change it before posting.`)) return;
    try { app.go({ screen: 'voucher', params: { input: await api.get<VoucherInput>(c(`/vouchers/${v.id}/correction-note`)) } }); }
    catch (e) { setError({ message: e instanceof ApiError ? e.message : String(e) }); }
  };
  const reverse = async () => {
    if (!v || !canChange) return;
    if (closedInvoice) { await offerNote(); return; }
    if (!window.confirm(`Reverse ${v.typeName} No. ${v.voucherNo}? A mirror-image voucher is posted; the original stays in the books.`)) return;
    try {
      const r = await api.post<{ voucherNo: string }>(c(`/vouchers/${v.id}/reverse`), {});
      app.toast(`Reversed. Reversal No. ${r.voucherNo}`);
      app.bumpData();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'USE_NOTE') { await offerNote(); return; }
      setError({ message: e instanceof ApiError ? e.message : String(e) });
    }
  };
  const alter = () => {
    if (!v?.input || !canChange) return;
    if (closedInvoice) { void offerNote(); return; }
    app.go({ screen: 'voucher', params: { input: v.input, alterOf: v.id, alterNo: v.voucherNo } });
  };
  useKeys({ 'Alt+X': () => { void reverse(); }, 'Alt+A': () => alter() });

  if (!v) return <div><ErrorBox error={error} /></div>;
  return (
    <div className="voucher-view">
      <ScreenHead title={`${v.typeName} No. ${v.voucherNo}`} sub={`${fmtDate(v.date)} · posted via ${v.source.toLowerCase()} · ₹${inr(v.totalMinor)}`}>
        {canChange && v.input && <button onClick={alter}>Alter <Kbd>Alt+A</Kbd></button>}
        {canChange && <button className="danger" onClick={() => void reverse()}>Reverse <Kbd>Alt+X</Kbd></button>}
      </ScreenHead>
      {v.reversedById && <div className="warn">This voucher was reversed by No. {v.reversedByNo}. <button className="link" onClick={() => app.replace({ screen: 'voucher-view', params: { id: v.reversedById! } })}>Open reversal</button></div>}
      {v.reversesVoucherId && <div className="warn">This is the reversal of No. {v.reversesNo}. <button className="link" onClick={() => app.replace({ screen: 'voucher-view', params: { id: v.reversesVoucherId! } })}>Open original</button></div>}
      <ErrorBox error={error} />

      <dl className="facts">
        {v.partyName && <><dt>Party</dt><dd>{v.partyName}{v.partyGstin && <small> · {v.partyGstin}</small>}</dd></>}
        {v.paymentMode && <><dt>Mode</dt><dd>{v.paymentMode.toLowerCase()}</dd></>}
        {v.partyRefNo && <><dt>Supplier invoice</dt><dd>{v.partyRefNo} {v.partyRefDate && `· ${fmtDate(v.partyRefDate)}`}</dd></>}
        {v.originalRef && <><dt>Against</dt><dd>{v.originalRef}</dd></>}
        {v.placeOfSupply && <><dt>Place of supply</dt><dd>{v.placeOfSupply} {app.status.states[v.placeOfSupply]}</dd></>}
        {v.reverseCharge && <><dt>Reverse charge</dt><dd>Yes</dd></>}
        {v.narration && <><dt>Narration</dt><dd>{v.narration}</dd></>}
      </dl>

      <h3>Ledger entries</h3>
      <table className="list">
        <thead><tr><th>Ledger</th><th>Bill</th><th className="num">Debit ₹</th><th className="num">Credit ₹</th></tr></thead>
        <tbody>
          {v.entries.map((e) => {
            const a = BigInt(e.amountMinor);
            return (
              <tr key={e.lineNo} tabIndex={0} onClick={() => app.go({ screen: 'ledger', params: { ledgerId: e.ledgerId } })}>
                <td>{e.ledgerName}</td>
                <td>{e.billRef ? `${e.billType?.replace('_', ' ').toLowerCase()} ${e.billRef}${e.dueDate ? ` · due ${fmtDate(e.dueDate)}` : ''}` : ''}</td>
                <td className="num">{a > 0n ? inr(a) : ''}</td><td className="num">{a < 0n ? inr(-a) : ''}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot><tr><td colSpan={2}>Total</td><td className="num">{inr(v.totalMinor)}</td><td className="num">{inr(v.totalMinor)}</td></tr></tfoot>
      </table>

      {v.inventory.length > 0 && <>
        <h3>Stock movement</h3>
        <table className="list">
          <thead><tr><th>Item</th><th>Godown</th><th className="num">Qty</th><th className="num">Unit cost ₹</th></tr></thead>
          <tbody>{v.inventory.map((m) => <tr key={m.lineNo}><td>{m.itemName}</td><td>{m.godown}</td><td className="num">{Number(m.qty)} {m.uom}</td><td className="num">{m.unitCost ? Number(m.unitCost).toFixed(2) : 'at running cost'}</td></tr>)}</tbody>
        </table>
      </>}

      {v.taxes.length > 0 && <>
        <h3>GST</h3>
        <table className="list">
          <thead><tr><th>Line</th><th>HSN/SAC</th><th>Tax</th><th className="num">Taxable ₹</th><th className="num">Tax ₹</th></tr></thead>
          <tbody>{v.taxes.map((t, i) => <tr key={i}><td>{t.itemLineNo}</td><td>{t.hsnSac ?? '—'}</td><td>{t.component} {pct(t.ratePpm)}{t.reverseCharge ? ' (RCM)' : ''}{!t.itcEligible ? ' · no ITC' : ''}</td><td className="num">{inr(t.taxableMinor)}</td><td className="num">{inr(t.taxMinor)}</td></tr>)}</tbody>
        </table>
      </>}

      <p className="audit muted small">Audit: chain position {v.chainSeq} · hash <code>{v.rowHash.slice(0, 16)}…</code> · posted {new Date(v.postedAt).toLocaleString('en-IN')} · {TYPE_LABEL[v.voucherType]} vouchers can't be edited in place; Alter posts a reversal plus a corrected voucher in one transaction.</p>
    </div>
  );
}
