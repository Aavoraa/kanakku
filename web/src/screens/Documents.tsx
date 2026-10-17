import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, c, ApiError, type VoucherInput } from '../api';
import { useApp } from '../state';
import { useKeys } from '../keys';
import { Picker, type Option } from '../components/Picker';
import { Empty, ErrorBox, Kbd, ScreenHead } from '../components/ui';
import { fmtDate, fromMinor, inr, TYPE_LABEL } from '../format';
import { DOC_STATUS, ReviewDoc } from './Review';
import { AiDataNotice } from '../components/Privacy';

export const DOC_TYPE_LABEL: Record<string, string> = {
  PURCHASE_BILL: 'Purchase bill', EXPENSE_RECEIPT: 'Expense receipt', SALES_INVOICE: 'Sales invoice',
  CREDIT_NOTE_RECEIVED: 'Credit note received', DEBIT_NOTE_RECEIVED: 'Debit note received',
  CREDIT_NOTE_ISSUED: 'Credit note issued', DEBIT_NOTE_ISSUED: 'Debit note issued',
  BANK_STATEMENT: 'Bank statement', WORKINGS: 'Workings / journal', REGISTER: 'Invoice register',
};
const MULTI = new Set(['BANK_STATEMENT', 'WORKINGS', 'REGISTER']);

interface DocRow {
  id: string; fileName: string; mime: string; status: string; error: string | null; createdAt: string; voucherId: string | null;
  docType: string | null; bankLedgerName: string | null; counts: Record<string, number> | null;
  supplier: string | null; invoiceNo: string | null; grandTotal: string | null; errors: number;
}

const countText = (c: Record<string, number> | null) => {
  if (!c) return '';
  const parts = [
    c.READY && `${c.READY} ready`, c.NEEDS_INPUT && `${c.NEEDS_INPUT} to check`, c.IN_BOOKS && `${c.IN_BOOKS} already in books`,
    c.POSTED && `${c.POSTED} posted`, c.SKIPPED && `${c.SKIPPED} skipped`,
  ].filter(Boolean);
  return parts.join(' · ');
};

// ---------------------------------------------------------------- Upload + list
export function DocumentsQueue({ params }: { params?: { upload?: boolean } }) {
  const app = useApp();
  const [docs, setDocs] = useState<DocRow[]>([]);
  const [dragging, setDragging] = useState(false);
  const [uploadErrors, setUploadErrors] = useState<string[]>([]);
  const [docType, setDocType] = useState('AUTO');
  const [bankLedgerId, setBankLedgerId] = useState('');
  const [registerKind, setRegisterKind] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const banks = app.masters.ledgers.filter((l) => l.isCashBank && l.systemCode !== 'CASH');

  const load = useCallback(() => api.get<DocRow[]>(c('/documents')).then(setDocs), []);
  const remove = async (d: DocRow) => {
    if (!window.confirm(`Delete ${d.fileName}? The file and anything not yet posted from it are removed. This cannot be undone.`)) return;
    try {
      await api.delete(c(`/documents/${d.id}`));
      app.toast(`Deleted ${d.fileName}`);
      await load();
    } catch (x) { app.toast(x instanceof ApiError ? x.message : String(x), 'error'); }
  };
  useEffect(() => { void load(); }, [load, app.dataVersion]);
  useEffect(() => {
    if (!docs.some((d) => d.status === 'RECEIVED' || d.status === 'PROCESSING')) return;
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
  }, [docs, load]);
  useEffect(() => { if (params?.upload) setTimeout(() => fileRef.current?.click(), 50); }, [params?.upload]);
  useKeys({ 'Ctrl+U': () => { fileRef.current?.click(); } });

  const upload = async (files: FileList | File[]) => {
    const fd = new FormData();
    // Choices first: the server applies them to the files that follow.
    fd.append('docType', docType);
    if (bankLedgerId) fd.append('bankLedgerId', bankLedgerId);
    if (registerKind) fd.append('registerKind', registerKind);
    for (const f of Array.from(files)) fd.append('file', f, f.name);
    try {
      const r = await api.post<{ fileName: string; error?: { message: string } }[]>(c('/documents'), fd);
      setUploadErrors(r.filter((x) => x.error).map((x) => `${x.fileName}: ${x.error!.message}`));
      const ok = r.filter((x) => !x.error).length;
      if (ok) app.toast(`${ok} file${ok > 1 ? 's' : ''} uploaded; reading now`);
      void load();
    } catch (e) { setUploadErrors([e instanceof ApiError ? e.message : String(e)]); }
  };

  return (
    <div>
      <ScreenHead title="Documents" sub="Bills, invoices, bank statements, workings and invoice registers become entries. You check, then post.">
        <button className="primary" onClick={() => fileRef.current?.click()}>Upload <Kbd>Ctrl+U</Kbd></button>
      </ScreenHead>
      <div className="upload-options">
        <label>Document type
          <select value={docType} onChange={(e) => setDocType(e.target.value)}>
            <option value="AUTO">Detect automatically</option>
            <option value="PURCHASE_BILL">Purchase bill / expense receipt</option>
            <option value="SALES_INVOICE">Sales invoice (issued by you)</option>
            <option value="BANK_STATEMENT">Bank statement</option>
            <option value="WORKINGS">Workings / journal sheet</option>
            <option value="REGISTER">Invoice register (Excel/CSV)</option>
          </select>
        </label>
        {(docType === 'AUTO' || docType === 'BANK_STATEMENT') && (
          <label>Bank account
            <select value={bankLedgerId} onChange={(e) => setBankLedgerId(e.target.value)}>
              <option value="">Detect from the statement</option>
              {banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </label>
        )}
        {(docType === 'AUTO' || docType === 'REGISTER') && (
          <label>Register is
            <select value={registerKind} onChange={(e) => setRegisterKind(e.target.value)}>
              <option value="">Detect from headings</option>
              <option value="SALES">Sales</option>
              <option value="PURCHASE">Purchases</option>
            </select>
          </label>
        )}
      </div>
      {!app.status.aiEnabled && <div className="warn small">AI is off: Excel and CSV files (bank statements, journal sheets, invoice registers) are read without it. PDFs, photos and free-form workings need it. <button className="link" onClick={() => app.setAiKeyOpen(true)}>Enter your API key</button></div>}
      {app.status.aiEnabled && <AiDataNotice compact />}
      <input ref={fileRef} type="file" multiple hidden
        accept="application/pdf,image/jpeg,image/png,image/webp,.csv,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        onChange={(e) => { if (e.target.files?.length) void upload(e.target.files); e.target.value = ''; }} />
      <div className={`dropzone ${dragging ? 'over' : ''}`} onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); if (e.dataTransfer.files.length) void upload(e.dataTransfer.files); }}
        onClick={() => fileRef.current?.click()} onKeyDown={(e) => { if (e.key === 'Enter') fileRef.current?.click(); }} role="button" tabIndex={0}>
        Drop files here or click to choose · PDF, photo, Excel (.xlsx) or CSV
      </div>
      {uploadErrors.map((e) => <div key={e} className="error-box">{e}</div>)}
      {docs.length === 0 ? <Empty>No documents yet.</Empty> : (
        <table className="list selectable">
          <thead><tr><th>Uploaded</th><th>File</th><th>Type</th><th>Details</th><th>Status</th><th></th></tr></thead>
          <tbody>{docs.map((d) => {
            const multi = d.docType && MULTI.has(d.docType);
            return (
              <tr key={d.id} tabIndex={0} className="clickable" onClick={() => app.go({ screen: 'review-doc', params: { id: d.id } })}
                onKeyDown={(e) => { if (e.key === 'Enter') app.go({ screen: 'review-doc', params: { id: d.id } }); }}>
                <td>{new Date(d.createdAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
                <td>{d.fileName}</td>
                <td>{d.docType ? DOC_TYPE_LABEL[d.docType] ?? d.docType : '—'}</td>
                <td>{multi ? <>{d.bankLedgerName && <span>{d.bankLedgerName} · </span>}<span className="muted">{countText(d.counts)}</span></>
                  : <>{d.supplier ?? ''}{d.invoiceNo ? ` · ${d.invoiceNo}` : ''}{d.grandTotal ? ` · ₹${d.grandTotal}` : ''}</>}</td>
                <td><span className={`status st-${d.status.toLowerCase()}`}>{DOC_STATUS[d.status]}</span>
                  {d.errors > 0 && d.status === 'NEEDS_REVIEW' && <small className="bad"> · {d.errors} to fix</small>}
                  {d.error && <small className="bad"> · {d.error.slice(0, 90)}</small>}</td>
                <td className="actions">
                  {d.status !== 'RECEIVED' && d.status !== 'PROCESSING' &&
                    <button className="ghost danger" title="Delete this document" onClick={(e) => { e.stopPropagation(); void remove(d); }} onKeyDown={(e) => e.stopPropagation()}>Delete</button>}
                </td>
              </tr>
            );
          })}</tbody>
        </table>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Opening a document
/** Single bills open the bill review; statements, workings and registers open the entries review. */
export function DocumentScreen({ params }: { params: { id: string } }) {
  const [kind, setKind] = useState<'bill' | 'entries' | null>(null);
  useEffect(() => {
    let stop = false;
    const check = async () => {
      const d = await api.get<{ docType: string | null; status: string; entries: unknown[] }>(c(`/documents/${params.id}`));
      if (stop) return;
      if (d.status === 'RECEIVED' || d.status === 'PROCESSING') { setKind(null); setTimeout(check, 1500); return; }
      setKind(d.entries.length > 0 || (d.docType && MULTI.has(d.docType)) ? 'entries' : 'bill');
    };
    void check();
    return () => { stop = true; };
  }, [params.id]);
  if (kind === null) return <div className="muted">Reading the document…</div>;
  return kind === 'bill' ? <ReviewDoc params={params} /> : <EntriesReview id={params.id} />;
}

// ---------------------------------------------------------------- Entries review
interface Entry {
  id: string; lineNo: number; kind: 'BANK_LINE' | 'JOURNAL' | 'REGISTER_ROW'; status: string;
  source: Record<string, any>; payload: VoucherInput | null;
  suggestion: { how: string; confidence: string; reason: string; counterLedgerId?: string; counterName?: string; newParty?: { name: string }; unmatched?: { index: number; account: string }[] };
  issues: { code: string; severity: string; message: string }[];
  amountMinor: string | null; entryDate: string | null; voucherId: string | null; voucherNo: string | null; matchedVoucherId: string | null; matchedVoucherNo: string | null;
}
interface DocDetail {
  id: string; fileName: string; status: string; error: string | null; docType: string | null; bankLedgerId: string | null;
  summary: Record<string, any> | null; entries: Entry[];
}

const STATUS_LABEL: Record<string, string> = { READY: 'ready', NEEDS_INPUT: 'to check', IN_BOOKS: 'in books', POSTED: 'posted', SKIPPED: 'skipped' };
const FILTERS: [string, string][] = [['ALL', 'All'], ['NEEDS_INPUT', 'To check'], ['READY', 'Ready'], ['IN_BOOKS', 'In books'], ['POSTED', 'Posted'], ['SKIPPED', 'Skipped']];

function bankEntryPayload(src: Record<string, any>, bankLedgerId: string, counterId: string, contra: boolean, billRef: string | null): VoucherInput {
  const inward = src.direction === 'IN';
  const amount = fromMinor(BigInt(inward ? src.creditMinor : src.debitMinor));
  const bank = { ledgerId: bankLedgerId, side: inward ? 'DR' as const : 'CR' as const, amount };
  const other = { ledgerId: counterId, side: inward ? 'CR' as const : 'DR' as const, amount, billRef: contra ? null : billRef };
  return {
    voucherType: contra ? 'CONTRA' : inward ? 'RECEIPT' : 'PAYMENT', date: src.date,
    narration: [src.narration, src.ref ? `Ref ${src.ref}` : null].filter(Boolean).join(' · ').slice(0, 1000),
    entries: inward ? [bank, other] : [other, bank],
  };
}

export function EntriesReview({ id }: { id: string }) {
  const app = useApp();
  const [d, setD] = useState<DocDetail | null>(null);
  const [filter, setFilter] = useState('ALL');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ message: string } | null>(null);

  const load = useCallback(async () => setD(await api.get<DocDetail>(c(`/documents/${id}`))), [id]);
  useEffect(() => { void load(); }, [load, app.dataVersion]);
  useEffect(() => {
    if (d && (d.status === 'RECEIVED' || d.status === 'PROCESSING')) { const t = setTimeout(() => void load(), 1500); return () => clearTimeout(t); }
  }, [d, load]);

  const ledgerById = useMemo(() => new Map(app.masters.ledgers.map((l) => [l.id, l])), [app.masters.ledgers]);
  // Reading a document can create ledgers (a new bank account, Bank Charges): pick them up once.
  const refreshed = useRef('');
  useEffect(() => {
    if (!d || refreshed.current === d.id) return;
    const ids = [d.bankLedgerId, ...d.entries.flatMap((e) => (e.payload?.entries ?? []).map((x) => x.ledgerId))].filter(Boolean) as string[];
    if (ids.some((x) => !ledgerById.has(x))) { refreshed.current = d.id; void app.refreshMasters(); }
  }, [d, ledgerById, app]);
  const counterOptions: Option[] = useMemo(() => app.masters.ledgers
    .filter((l) => !l.taxComponent && l.id !== d?.bankLedgerId)
    .map((l) => ({ id: l.id, label: l.name, sub: l.groupName })), [app.masters.ledgers, d?.bankLedgerId]);

  const fail = (e: unknown) => setErr({ message: e instanceof ApiError ? e.message : String(e) });

  const setCounter = async (e: Entry, counterId: string | null) => {
    if (!counterId || !d?.bankLedgerId) return;
    const keepBill = e.suggestion.counterLedgerId === counterId ? (e.payload?.entries?.find((x) => x.ledgerId === counterId)?.billRef ?? null) : null;
    try {
      await api.put(c(`/documents/${id}/entries/${e.id}`), { payload: bankEntryPayload(e.source, d.bankLedgerId, counterId, Boolean(ledgerById.get(counterId)?.isCashBank), keepBill) });
      await load();
    } catch (x) { fail(x); }
  };

  const post = async (e: Entry, confirmWarnings = false): Promise<void> => {
    try {
      await api.post(c(`/documents/${id}/entries/${e.id}/post`), { confirmWarnings });
      app.bumpData();
      await load();
    } catch (x) {
      if (x instanceof ApiError && x.code === 'CONFIRM_WARNINGS' && window.confirm(`${x.message}\n\nPost anyway?`)) return post(e, true);
      fail(x);
    }
  };
  const skip = async (e: Entry, value: boolean) => {
    try { await api.post(c(`/documents/${id}/entries/${e.id}/skip`), { skip: value }); await load(); } catch (x) { fail(x); }
  };
  const postAll = async () => {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const r = await api.post<{ posted: number; failed: { message: string }[] }>(c(`/documents/${id}/post-ready`), {});
      app.toast(`Posted ${r.posted} entr${r.posted === 1 ? 'y' : 'ies'}${r.failed.length ? `; ${r.failed.length} need attention` : ''}`, r.failed.length ? 'info' : 'ok');
      app.bumpData();
      await load();
    } catch (x) { fail(x); } finally { setBusy(false); }
  };
  const reprocess = async (opts: Record<string, string>) => {
    try { await api.post(c(`/documents/${id}/retry`), opts); app.toast('Re-reading with your choice'); await load(); } catch (x) { fail(x); }
  };
  const edit = (e: Entry) => {
    let input = e.payload;
    if (!input && e.kind === 'JOURNAL') {
      input = { voucherType: 'JOURNAL', date: e.source.date ?? app.status.today, narration: e.source.narration ?? null,
        entries: (e.source.lines as { account: string; side: 'DR' | 'CR'; amountMinor: string }[]).map((l) => ({
          // Accounts that do match a ledger come pre-filled; only the missing ones are left to pick.
          ledgerId: app.masters.ledgers.find((x) => x.name.toLowerCase() === l.account.trim().toLowerCase())?.id ?? '',
          side: l.side, amount: fromMinor(BigInt(l.amountMinor)),
        })) };
    }
    if (!input) return;
    const missing = (e.suggestion.unmatched ?? []).map((u) => `"${u.account}"`);
    const note = missing.length ? `${missing.join(', ')} ${missing.length > 1 ? 'are not ledgers' : 'is not a ledger'} yet: pick one, or type the name and press Alt+C to create it.` : undefined;
    app.go({ screen: 'voucher', params: { input, docEntry: { documentId: id, entryId: e.id, lineNo: e.lineNo, note } } });
  };

  useKeys({ 'Ctrl+A': () => { void postAll(); } });

  if (!d) return <div className="muted">Loading…</div>;
  if (d.status === 'RECEIVED' || d.status === 'PROCESSING') return <div className="muted">Reading {d.fileName}…</div>;
  const s = d.summary ?? {};
  const counts = d.entries.reduce<Record<string, number>>((m, e) => ({ ...m, [e.status]: (m[e.status] ?? 0) + 1 }), {});
  const shown = d.entries.filter((e) => filter === 'ALL' || e.status === filter);
  const isBank = d.docType === 'BANK_STATEMENT';
  const needsKind = d.entries.some((e) => e.issues.some((i) => i.code === 'REGISTER_KIND'));
  const banks = app.masters.ledgers.filter((l) => l.isCashBank && l.systemCode !== 'CASH');

  return (
    <div className="entries-review">
      <ScreenHead title={`${DOC_TYPE_LABEL[d.docType ?? ''] ?? 'Document'}: ${d.fileName}`}
        sub={isBank ? `${s.bankLedgerName ?? ''} · ${fmtDate(s.periodFrom)} to ${fmtDate(s.periodTo)} · ${d.entries.length} lines` : `${d.entries.length} entries`}>
        <button className="primary" onClick={() => void postAll()} disabled={busy || !counts.READY}>Post all ready ({counts.READY ?? 0}) <Kbd>Ctrl+A</Kbd></button>
      </ScreenHead>

      {isBank && (
        <div className="statement-summary">
          <label>Bank account
            <select value={d.bankLedgerId ?? ''} onChange={(e) => void reprocess({ bankLedgerId: e.target.value })}>
              {banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </label>
          <dl>
            <dt>Opening</dt><dd className="num">{s.openingMinor != null ? `₹${inr(s.openingMinor)}` : '—'}</dd>
            <dt>Deposits</dt><dd className="num">₹{inr(s.deposits ?? '0')}</dd>
            <dt>Withdrawals</dt><dd className="num">₹{inr(s.withdrawals ?? '0')}</dd>
            <dt>Closing</dt><dd className="num">{s.closingMinor != null ? `₹${inr(s.closingMinor)}` : '—'}</dd>
          </dl>
        </div>
      )}
      {needsKind && (
        <div className="warn">Is this a sales or a purchase register?
          <button onClick={() => void reprocess({ registerKind: 'SALES' })}>Sales</button> <button onClick={() => void reprocess({ registerKind: 'PURCHASE' })}>Purchases</button>
        </div>
      )}
      {(s.issues as { severity: string; message: string }[] | undefined)?.map((i, k) => <div key={k} className={i.severity === 'error' ? 'error-box' : 'warn small'}>{i.message}</div>)}
      {(s.warnings as string[] | undefined)?.map((w, k) => <div key={k} className="warn small">{w}</div>)}
      <ErrorBox error={err} />

      <div className="tabs" role="tablist">
        {FILTERS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={filter === k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>
            {label}{k !== 'ALL' && counts[k] ? ` (${counts[k]})` : k === 'ALL' ? ` (${d.entries.length})` : ''}
          </button>
        ))}
      </div>

      {shown.length === 0 ? <Empty>Nothing here.</Empty> : (
        <table className="list entries">
          <thead><tr>
            <th>#</th><th>Date</th><th>{isBank ? 'Narration' : 'Entry'}</th>
            {isBank ? <><th className="num">In ₹</th><th className="num">Out ₹</th></> : <th className="num">Amount ₹</th>}
            <th>{isBank ? 'Post to' : 'Details'}</th><th>Status</th><th></th>
          </tr></thead>
          <tbody>{shown.map((e) => {
            const open = e.status === 'READY' || e.status === 'NEEDS_INPUT';
            const counterId = isBank ? e.payload?.entries?.find((x) => x.ledgerId !== d.bankLedgerId)?.ledgerId ?? null : null;
            return (
              <tr key={e.id} className={`st-row-${e.status.toLowerCase()}`}>
                <td className="muted">{e.lineNo}</td>
                <td className="nowrap">{fmtDate(e.entryDate)}</td>
                <td className="desc">
                  {isBank ? e.source.narration : e.kind === 'REGISTER_ROW' ? `${e.source.invoiceNo} · ${e.source.partyName}` : e.source.narration ?? e.payload?.narration ?? '—'}
                  {e.kind === 'JOURNAL' && <ul className="jlines">{(e.source.lines as { account: string; side: string; amountMinor: string }[]).map((l, i) => {
                    const missing = open && e.suggestion.unmatched?.some((u) => u.index === i);
                    return <li key={i} className={missing ? 'bad' : ''}>{l.side === 'DR' ? 'Dr' : 'Cr'} {l.account} {inr(l.amountMinor)}{missing ? ' (no such ledger)' : ''}</li>;
                  })}</ul>}
                  {e.issues.filter((i) => open || (e.status === 'IN_BOOKS' && i.severity !== 'info')).map((i, k) => <div key={k} className={`issue ${i.severity}`}>{i.message}</div>)}
                </td>
                {isBank
                  ? <><td className="num">{e.source.direction === 'IN' ? inr(e.source.creditMinor) : ''}</td><td className="num">{e.source.direction === 'OUT' ? inr(e.source.debitMinor) : ''}</td></>
                  : <td className="num">{e.amountMinor ? inr(e.amountMinor) : ''}</td>}
                <td className="post-to">
                  {isBank && open && <Picker options={counterOptions} value={counterId} onChange={(v) => void setCounter(e, v)} placeholder="Choose ledger…" />}
                  {isBank && !open && <span>{e.suggestion.counterName ?? ''}</span>}
                  {!isBank && e.payload && <span>{TYPE_LABEL[e.payload.voucherType]}{e.suggestion.newParty && open ? ` · new party ${e.suggestion.newParty.name}` : ''}</span>}
                  <small className="muted reason">{e.status === 'POSTED' && e.suggestion.newParty ? '' : e.suggestion.reason}{e.suggestion.how === 'ai' ? ' (AI)' : e.suggestion.how === 'learned' ? ' (learned from your earlier choice)' : ''}</small>
                </td>
                <td>
                  <span className={`status st-${e.status.toLowerCase()}`}>{STATUS_LABEL[e.status]}</span>
                  {e.voucherId && <button className="link" onClick={() => app.go({ screen: 'voucher-view', params: { id: e.voucherId } })}>No. {e.voucherNo}</button>}
                  {e.matchedVoucherId && <button className="link" onClick={() => app.go({ screen: 'voucher-view', params: { id: e.matchedVoucherId } })}>No. {e.matchedVoucherNo}</button>}
                </td>
                <td className="actions">
                  {open && e.payload && <button className="primary" onClick={() => void post(e)}>Post</button>}
                  {open && (e.payload || e.kind === 'JOURNAL') && <button onClick={() => edit(e)}>Edit</button>}
                  {open && <button className="ghost" onClick={() => void skip(e, true)}>Skip</button>}
                  {e.status === 'SKIPPED' && <button className="ghost" onClick={() => void skip(e, false)}>Undo skip</button>}
                </td>
              </tr>
            );
          })}</tbody>
        </table>
      )}
      <p className="hint-bar">Lines already in your books are never posted twice. Ledgers you pick for bank lines are remembered for similar narrations next time.</p>
    </div>
  );
}
