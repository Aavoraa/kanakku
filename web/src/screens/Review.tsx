import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, c, ApiError, type Posted, type Preview, type VoucherInput, type ItemLineInput } from '../api';
import { useApp } from '../state';
import { useKeys } from '../keys';
import { Picker, type Option } from '../components/Picker';
import { ErrorBox, Kbd, ScreenHead } from '../components/ui';
import { fmtDate, inr, pct, toMinor, TYPE_LABEL } from '../format';

export const DOC_STATUS: Record<string, string> = { RECEIVED: 'queued', PROCESSING: 'reading…', NEEDS_REVIEW: 'needs review', ACCEPTED: 'done', REJECTED: 'rejected', FAILED: 'failed' };

interface Issue { code: string; field: string; severity: 'error' | 'warning' | 'info'; message: string }
interface PartyCand { id: string; name: string; gstin: string | null; city: string | null; score: number }
interface Detail {
  id: string; fileName: string; mime: string; status: string; error: string | null; voucherId: string | null; model: string | null; docType: string | null;
  extraction: { supplier: { name: { value: string | null }; gstin: { value: string | null } }; buyer: { name: { value: string | null } }; invoice_number: { value: string | null; raw: string | null }; totals: { grand_total: { value: string | null } }; document_type: string } | null;
  validation: Issue[] | null;
  matches: {
    party: { status: string; reason: string; match: PartyCand | null; candidates: PartyCand[] };
    proposedParty: { name: string; gstin: string | null; stateCode: string | null; creditDays: number | null } | null;
    lines: { description: string; itemName: string | null; ledgerName: string | null; reason: string; score: number }[];
    recomputedTotal: string | null; voucherType?: string; partyRole?: 'supplier' | 'customer';
  } | null;
  draft: VoucherInput | null;
}

/** Review screen for a single bill or invoice (purchase or sales side). */
export function ReviewDoc({ params }: { params: { id: string } }) {
  const app = useApp();
  const [d, setD] = useState<Detail | null>(null);
  const [draft, setDraft] = useState<VoucherInput | null>(null);
  const [newParty, setNewParty] = useState<{ name: string; gstin: string; stateCode: string; creditDays: string } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [err, setErr] = useState<{ message: string; details?: unknown } | null>(null);
  const [confirm, setConfirm] = useState<string[] | null>(null);

  const load = useCallback(async () => {
    const doc = await api.get<Detail>(c(`/documents/${params.id}`));
    setD(doc);
    if (doc.draft) setDraft(doc.draft);
    if (doc.matches?.proposedParty && !doc.draft?.counterpartyId) {
      const p = doc.matches.proposedParty;
      setNewParty({ name: p.name, gstin: p.gstin ?? '', stateCode: p.stateCode ?? '', creditDays: p.creditDays ? String(p.creditDays) : '' });
    }
  }, [params.id]);
  const loadSafely = useCallback(() => load().catch((e) => setErr(e instanceof ApiError ? { message: e.message } : { message: String(e) })), [load]);
  useEffect(() => { void loadSafely(); }, [loadSafely]);
  useEffect(() => {
    if (d && (d.status === 'RECEIVED' || d.status === 'PROCESSING')) { const t = setTimeout(() => void loadSafely(), 2000); return () => clearTimeout(t); }
  }, [d, loadSafely]);

  useEffect(() => {
    if (!draft) return;
    // Only the newest preview may land; an older, slower reply would show the wrong totals.
    let live = true;
    const t = setTimeout(async () => {
      try {
        const p = await api.post<Preview>(c('/vouchers/preview'), { ...draft, paymentMode: draft.counterpartyId ? draft.paymentMode : 'CASH', confirmWarnings: true });
        if (live) setPreview(p);
      } catch { if (live) setPreview(null); }
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [draft]);

  const customer = d?.matches?.partyRole === 'customer';
  const voucherType = draft?.voucherType ?? 'PURCHASE';
  const lineOptions: Option[] = useMemo(() => [
    ...app.masters.items.map((i) => ({ id: `item:${i.id}`, label: i.name, sub: `${i.uom} · ${pct(i.gstRatePpm)}` })),
    ...app.masters.ledgers
      .filter((l) => (customer ? l.nature === 'INCOME' : l.nature === 'EXPENSE' || l.path.includes('fixed_assets')))
      .filter((l) => !l.taxComponent && l.systemCode !== 'ROUND_OFF')
      .map((l) => ({ id: `ledger:${l.id}`, label: l.name, sub: l.groupName })),
  ], [app.masters, customer]);
  const partyOptions: Option[] = useMemo(() => app.masters.parties
    .filter((p) => (customer ? p.kind !== 'SUPPLIER' : p.kind !== 'CUSTOMER') || p.id === draft?.counterpartyId)
    .map((p) => ({ id: p.id, label: p.name, sub: [p.city, p.gstin].filter(Boolean).join(' · ') })), [app.masters.parties, customer, draft?.counterpartyId]);

  const setLine = (i: number, patch: Partial<ItemLineInput>) => setDraft((dr) => dr && ({ ...dr, items: dr.items!.map((l, j) => (j === i ? { ...l, ...patch } : l)) }));

  // A second Ctrl+A while the first is still posting must not send the bill again.
  const posting = useRef(false);
  const accept = async () => {
    if (!draft || !d || posting.current) return;
    posting.current = true;
    try {
      const posted = await api.post<Posted>(c(`/documents/${d.id}/accept`), {
        draft,
        newParty: !draft.counterpartyId && newParty ? { ...newParty, gstin: newParty.gstin || null, stateCode: newParty.stateCode || null, creditDays: newParty.creditDays ? Number(newParty.creditDays) : null } : null,
        confirmWarnings: confirm !== null,
      });
      app.toast(`Posted ${TYPE_LABEL[posted.voucherType]} No. ${posted.voucherNo} · ₹${inr(posted.totalMinor)}`);
      app.bumpData();
      app.back();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CONFIRM_WARNINGS') setConfirm((e.details as { warnings: { message: string }[] }).warnings.map((w) => w.message));
      else setErr(e instanceof ApiError ? { message: e.message, details: e.details } : { message: String(e) });
    } finally { posting.current = false; }
  };
  const reject = async () => {
    if (!d || !window.confirm('Reject this document? Nothing will be posted.')) return;
    try {
      await api.post(c(`/documents/${d.id}/reject`), {});
      app.bumpData();
      app.back();
    } catch (e) { setErr(e instanceof ApiError ? { message: e.message, details: e.details } : { message: String(e) }); }
  };
  const retry = async () => {
    if (!d) return;
    try { await api.post(c(`/documents/${d.id}/retry`), {}); await load(); }
    catch (e) { setErr(e instanceof ApiError ? { message: e.message, details: e.details } : { message: String(e) }); }
  };
  useKeys({ 'Ctrl+A': () => { void accept(); }, 'Alt+R': () => { void reject(); } });

  if (!d) return err ? <ErrorBox error={err} /> : <div className="muted">Loading…</div>;
  const fileUrl = c(`/documents/${d.id}/file`);
  const printed = d.extraction?.totals.grand_total.value;
  const ours = preview ? BigInt(preview.totalMinor) : null;
  const printedMinor = printed ? toMinor(printed) : null;
  const totalsMatch = ours !== null && printedMinor !== null && (ours - printedMinor <= 100n && printedMinor - ours <= 100n);
  const issues = d.validation ?? [];
  const editable = d.status === 'NEEDS_REVIEW' || d.status === 'FAILED';
  const partyWord = customer ? 'customer' : 'supplier';
  const title = (customer ? d.extraction?.buyer.name.value : d.extraction?.supplier.name.value) ?? d.fileName;

  return (
    <div className="review">
      <ScreenHead title={title} sub={`${d.fileName} · ${TYPE_LABEL[voucherType] ?? ''} · ${DOC_STATUS[d.status]}${d.model ? ` · read by ${d.model}` : ''}`}>
        {d.status === 'FAILED' && <button onClick={() => void retry()}>Retry</button>}
        {editable && draft && <button className="danger" onClick={() => void reject()}>Reject <Kbd>Alt+R</Kbd></button>}
        {editable && draft && <button className="primary" onClick={() => void accept()}>Post {TYPE_LABEL[voucherType]?.toLowerCase()} <Kbd>Ctrl+A</Kbd></button>}
        {d.voucherId && <button onClick={() => app.go({ screen: 'voucher-view', params: { id: d.voucherId } })}>Open voucher</button>}
      </ScreenHead>
      {d.error && <div className="error-box">{d.error}</div>}
      <div className="review-split">
        <div className="doc-pane">
          {d.mime === 'application/pdf' ? <iframe src={fileUrl} title="Document" /> : <img src={fileUrl} alt="Uploaded document" />}
        </div>
        <div className="form-pane">
          {(d.status === 'RECEIVED' || d.status === 'PROCESSING') && <p className="muted">Reading the document…</p>}
          {issues.length > 0 && (
            <ul className="issues">
              {issues.map((i, k) => <li key={k} className={i.severity}><strong>{i.severity === 'error' ? 'Fix' : i.severity === 'warning' ? 'Check' : 'OK'}</strong> {i.message}</li>)}
            </ul>
          )}
          {draft && d.matches && (
            <>
              <h3>{customer ? 'Customer' : 'Supplier'}</h3>
              <div className="match">
                <span className={`pill ${d.matches.party.status.toLowerCase()}`}>{d.matches.party.status === 'MATCHED' ? 'matched' : d.matches.party.status === 'SUGGEST' ? 'please choose' : `new ${partyWord}`}</span>
                <small className="muted"> {d.matches.party.reason}</small>
              </div>
              <Picker options={partyOptions} value={draft.counterpartyId ?? null} onChange={(id) => setDraft({ ...draft, counterpartyId: id })} placeholder={`Choose existing ${partyWord}…`} />
              {d.matches.party.candidates.length > 0 && !draft.counterpartyId && (
                <div className="cands">Similar: {d.matches.party.candidates.map((p) => <button key={p.id} className="link" onClick={() => setDraft({ ...draft, counterpartyId: p.id })}>{p.name} ({Math.round(p.score * 100)}%)</button>)}</div>
              )}
              {!draft.counterpartyId && newParty && (
                <fieldset className="new-party">
                  <legend>…or create this {partyWord} on posting</legend>
                  <label>Name<input value={newParty.name} onChange={(e) => setNewParty({ ...newParty, name: e.target.value })} /></label>
                  <label>GSTIN<input value={newParty.gstin} onChange={(e) => setNewParty({ ...newParty, gstin: e.target.value.toUpperCase() })} /></label>
                  <label>State<select value={newParty.stateCode} onChange={(e) => setNewParty({ ...newParty, stateCode: e.target.value })}><option value="">—</option>{Object.entries(app.status.states).map(([k, v]) => <option key={k} value={k}>{k} {v}</option>)}</select></label>
                  <label>Credit days<input value={newParty.creditDays} onChange={(e) => setNewParty({ ...newParty, creditDays: e.target.value })} /></label>
                </fieldset>
              )}

              <h3>Invoice</h3>
              <div className="field-row">
                <label>Invoice no.<input value={draft.partyRefNo ?? ''} onChange={(e) => setDraft({ ...draft, partyRefNo: e.target.value })} maxLength={16} /></label>
                <label className="w-date">Invoice date<input type="date" value={draft.partyRefDate ?? ''} onChange={(e) => setDraft({ ...draft, partyRefDate: e.target.value, date: e.target.value })} /></label>
                <label>Mode<select value={draft.paymentMode} onChange={(e) => setDraft({ ...draft, paymentMode: e.target.value as 'CREDIT' })}><option value="CREDIT">Credit</option><option value="CASH">Cash</option><option value="BANK">Bank</option></select></label>
                {!customer && <label className="check"><input type="checkbox" checked={Boolean(draft.reverseCharge)} onChange={(e) => setDraft({ ...draft, reverseCharge: e.target.checked })} /> Reverse charge</label>}
              </div>

              <h3>Lines</h3>
              <table className="grid">
                <thead><tr><th>As printed</th><th>Post to</th><th className="num">Qty</th><th className="num">Amount ₹</th><th className="num">GST %</th></tr></thead>
                <tbody>{draft.items!.map((l, i) => {
                  const m = d.matches!.lines[i];
                  const ref = l.itemId ? `item:${l.itemId}` : l.ledgerId ? `ledger:${l.ledgerId}` : null;
                  return (
                    <tr key={i}>
                      <td className="printed">{l.description}{m && <small className="muted"> · {m.reason}</small>}</td>
                      <td className="w-item"><Picker options={lineOptions} value={ref} placeholder={customer ? 'Default: Sales ledger' : 'Default: Purchase ledger'}
                        onChange={(id) => setLine(i, id?.startsWith('item:') ? { itemId: id.slice(5), ledgerId: null } : { itemId: null, ledgerId: id ? id.slice(7) : null, qty: null })} /></td>
                      <td className="w-num"><input className="num" value={l.qty ?? ''} onChange={(e) => setLine(i, { qty: e.target.value || null })} disabled={!l.itemId} /></td>
                      <td className="w-amt"><input className="num" value={l.amount} onChange={(e) => setLine(i, { amount: e.target.value })} /></td>
                      <td className="w-rate"><input className="num" value={l.gstRate} onChange={(e) => setLine(i, { gstRate: e.target.value })} /></td>
                    </tr>
                  );
                })}</tbody>
              </table>
              {preview && (
                <dl className="totals">
                  <dt>Taxable</dt><dd className="num">{inr(preview.taxableMinor)}</dd>
                  <dt>GST</dt><dd className="num">{inr(preview.taxMinor)}</dd>
                  <dt className="grand">Our total</dt><dd className="num grand">₹{inr(preview.totalMinor)}</dd>
                  <dt>Printed total</dt><dd className={`num ${totalsMatch ? 'ok' : 'bad'}`}>{printedMinor !== null ? `₹${inr(printedMinor)}` : 'not read'} {totalsMatch ? '✓ matches' : printedMinor !== null ? '✗ differs' : ''}</dd>
                </dl>
              )}
              {confirm && <div className="warn strong">{confirm.map((w) => <div key={w}>{w}</div>)}<div>Press <Kbd>Ctrl+A</Kbd> again to post anyway.</div></div>}
              <ErrorBox error={err} />
              <p className="muted small">Document dated {fmtDate(draft.partyRefDate)} · voucher dated {fmtDate(draft.date)}. Corrections you make here teach the matcher for next time.</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
