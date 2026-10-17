import crypto from 'node:crypto';
import Decimal from 'decimal.js';
import type { PGlite } from '@electric-sql/pglite';
import type Anthropic from '@anthropic-ai/sdk';
import { maybeOne, one, type Db } from '../../db/client';
import { config } from '../../config';
import { AppError } from '../../lib/errors';
import { daysBetween, fyStart, resolvePeriod, todayIST, type PeriodName } from '../../lib/dates';
import { percentToPpm } from '../../lib/money';
import { stableStringify } from '../../lib/text';
import { hasTamil } from '../../lib/tamil';
import { LedgerContext } from '../../ledger/context';
import { bigintJson, postVoucher, previewVoucher, reverseVoucher } from '../../ledger/post';
import type { VoucherInputRaw } from '../../ledger/contracts';
import { partyOutstanding, ageing } from '../../reports/registers';
import { bankBalance, cashBalance, typeTotal } from '../../reports/dashboard';
import { gstSummary } from '../../reports/gst';
import { profitAndLoss } from '../../reports/financials';
import { claude, FALLBACK, loadPrompt, ModelStopped, wrapApiError } from '../anthropic';
import { voiceCandidates, type VoiceCandidates } from '../resolver';
import { normalizeTranscript } from './normalize';
import { groundRecordVoucher } from './grounding';
import { msgs, type Lang, type Messages } from './i18n';
import { normalizeToolInput, VOICE_TOOLS, type EntityRef, type RecordVoucherCall } from './tools';

export const VOICE_PROMPT = 'voice_intent.v4';
const CONFIRM_WINDOW_MS = 60_000;

// Fixed grammar for confirm / cancel (spec 4.5): English, Hinglish, Tamil script and romanised Tamil.
const CONFIRM_RE = new RegExp('^(' + [
  'yes', 'yeah', 'yep', 'confirm(ed)?', 'post( it)?', 'ok(ay)?( post( it)?)?', 'do it', 'correct',
  'haan( ji)?', 'han', 'ha', 'ji haan', 'haan post karo', 'post karo', 'theek hai', 'sahi hai',
  'சரி', 'சரிங்க', 'சரி போடு', 'ஆமா', 'ஆமாம்', 'ஆம்', 'ஓகே', 'ஓக்கே', 'போடு', 'போடுங்க', 'பதிவு செய்', 'பதிவு செய்யுங்கள்', 'பதிவு பண்ணு', 'கன்ஃபார்ம்',
  'sari', 'seri', 'saringa', 'aama', 'aamaa', 'aamam', 'podu', 'podunga', 'pathivu sei',
].join('|') + ')[.!]?$', 'i');
const CANCEL_RE = new RegExp('^(' + [
  'no', 'nope', 'cancel( it)?', 'stop', 'discard', 'nahi', 'nahin', 'mat karo', 'rehne do', 'chhodo',
  'வேண்டாம்', 'வேணாம்', 'ரத்து', 'ரத்து செய்', 'கேன்சல்', 'இல்லை', 'இல்ல', 'நிறுத்து',
  'vendam', 'venam', 'vendaam', 'rathu', 'illa', 'illai',
].join('|') + ')[.!]?$', 'i');
export const isConfirm = (t: string) => CONFIRM_RE.test(t.trim());
export const isCancel = (t: string) => CANCEL_RE.test(t.trim());

export interface VoiceRequest {
  transcript: string;
  confidence?: number | null;
  sessionId?: string | null;
  screen?: string | null;
  /** Language the user picked; Tamil script in the transcript switches to Tamil regardless. */
  lang?: Lang | null;
  /** Who is speaking: recorded as the creator of drafts and the poster of vouchers. */
  userId?: string;
}

export type VoiceResponse =
  | { kind: 'voucher'; sessionId: string; lang: Lang; speech: string; draft: Record<string, unknown> }
  | { kind: 'reverse'; sessionId: string; lang: Lang; speech: string; target: Record<string, unknown>; expiresAt: string }
  | { kind: 'clarify'; sessionId: string; lang: Lang; speech: string }
  | { kind: 'answer'; sessionId: null; lang: Lang; speech: string; data: unknown }
  | { kind: 'navigate'; sessionId: null; lang: Lang; speech: string; route: { screen: string; from: string; to: string; ledgerId: string | null } }
  | { kind: 'posted'; sessionId: null; lang: Lang; speech: string; voucher: { id: string; voucherNo: string; voucherType: string } }
  | { kind: 'cancelled'; sessionId: null; lang: Lang; speech: string };

interface Session {
  id: string;
  status: 'OPEN' | 'POSTED' | 'CANCELLED';
  kind: string | null;
  lang: Lang;
  transcripts: string[];
  last_call: RecordVoucherCall | null;
  draft_id: string | null;
  draft_hash: string | null;
  target_voucher_id: string | null;
  readback_at: Date | null;
  total_minor: bigint | null;
}

/** Per-turn state shared by the handlers. */
interface Turn { db: PGlite; ctx: LedgerContext; s: Session; lang: Lang; T: Messages; transcripts: string[]; userId: string }

export async function handleUtterance(db: PGlite, companyId: string, req: VoiceRequest): Promise<VoiceResponse> {
  const transcript = req.transcript.trim();
  if (!transcript) throw new AppError('EMPTY', 422, 'Nothing was heard');
  let session = req.sessionId ? await loadSession(db, companyId, req.sessionId) : null;
  if (session && session.status !== 'OPEN') session = null;
  // Tamil script in what was said switches English to Tamil; a Tanglish choice stays Tanglish.
  const picked: Lang = req.lang ?? session?.lang ?? 'en';
  const lang: Lang = picked === 'tanglish' ? 'tanglish' : hasTamil(transcript) ? 'ta' : picked;
  const T = msgs(lang);
  const userId = req.userId ?? config.localUserId;

  // Confirm / cancel are matched by a fixed grammar, never by the model (spec 4.5).
  if (session && session.readback_at) {
    if (isConfirm(transcript)) return confirmSession(db, companyId, session.id, 'voice', lang, userId);
    if (isCancel(transcript)) return cancelSession(db, companyId, session.id, lang);
  }
  if (!session) {
    if (isConfirm(transcript) || isCancel(transcript)) {
      return { kind: 'cancelled', sessionId: null, lang, speech: T.nothingToConfirm };
    }
    session = await createSession(db, companyId, lang);
  }
  if (session.lang !== lang) {
    await db.query(`UPDATE voice_sessions SET lang = $2 WHERE id = $1`, [session.id, lang]);
    session.lang = lang;
  }

  const transcripts = [...session.transcripts, transcript];
  const normalized = transcripts.map((t) => normalizeTranscript(t).text);
  const combined = normalized.join(' \n ');
  const ctx = await LedgerContext.load(db, companyId);
  const candidates = await voiceCandidates(db, companyId, transcripts.join(' '));
  const prompt = loadPrompt(VOICE_PROMPT);
  const today = todayIST();
  const turn: Turn = { db, ctx, s: session, lang, T, transcripts, userId };

  const contextBlock = [
    `<context>`,
    `today: ${today}`,
    `fiscal_year_start: ${fyStart(today, ctx.company.fy_start_month)}`,
    `company_state_code: ${ctx.company.state_code}`,
    `current_screen: ${req.screen ?? 'unknown'}`,
    `reply_language: ${lang === 'ta' ? 'Tamil' : lang === 'tanglish' ? 'Tanglish' : 'English'}`,
    `open_draft: ${session.last_call ? JSON.stringify(session.last_call) : 'none'}`,
    `</context>`,
    `<candidates>`,
    ...candidates.parties.map((p) => `${p.key}: party "${p.name}" (${p.group}${p.city ? `, ${p.city}` : ''})`),
    ...candidates.items.map((i) => `${i.key}: item "${i.name}" (unit ${i.uom}${i.gstRatePpm !== null ? `, GST ${i.gstRatePpm / 10_000}%` : ''})`),
    ...candidates.ledgers.map((l) => `${l.key}: ledger "${l.name}" (${l.group})`),
    `</candidates>`,
    `<transcript>`,
    ...normalized.map((t, i) => (i < normalized.length - 1 ? `earlier: ${t}` : `now: ${t}`)),
    `</transcript>`,
  ].join('\n');

  let call: { name: string; input: unknown };
  try {
    const resp = await claude().beta.messages.create({
      model: config.model,
      max_tokens: 4096,
      ...FALLBACK,
      output_config: { effort: 'low' },
      system: [{ type: 'text', text: prompt.text, cache_control: { type: 'ephemeral' } }],
      tools: VOICE_TOOLS,
      tool_choice: { type: 'auto' },
      messages: [{ role: 'user', content: contextBlock }],
    });
    if (resp.stop_reason === 'refusal' || resp.stop_reason === 'max_tokens') throw new ModelStopped(resp.stop_reason);
    const calls = resp.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
    if (calls.length !== 1) return keepAsking(turn, null, T.didntCatch);
    call = { name: calls[0].name, input: normalizeToolInput(calls[0].input) };
  } catch (e) {
    wrapApiError(e);
  }

  let response: VoiceResponse;
  let grounding: unknown = null;
  switch (call.name) {
    case 'record_voucher': {
      const input = call.input as RecordVoucherCall;
      const problems = groundRecordVoucher(input, combined);
      grounding = problems;
      if (problems.length) { response = await keepAsking(turn, input, T.askFor(problems[0].field)); break; }
      plainNumbers(input);
      if (req.confidence !== null && req.confidence !== undefined && req.confidence < 0.6 && input.amount) {
        response = await keepAsking(turn, input, T.lowConfidenceAmount(input.amount.value));
        break;
      }
      response = await recordVoucher(turn, input, candidates, combined);
      break;
    }
    case 'query_outstanding': response = await queryOutstanding(turn, call.input as { side: 'RECEIVABLE' | 'PAYABLE'; party: EntityRef | null; period: PeriodName }, candidates); break;
    case 'query_report': response = await queryReport(turn, call.input as { metric: string; period: PeriodName }); break;
    case 'navigate': response = await navigate(turn, call.input as { screen: string; period: PeriodName; ledger: EntityRef | null }, candidates); break;
    case 'reverse_voucher': response = await prepareReverse(turn, call.input as { voucher_type: string; voucher_no: string | null }); break;
    default: response = await keepAsking(turn, session.last_call, (call.input as { question?: string }).question ?? T.sayAgain);
  }

  await db.query(
    `INSERT INTO voice_turns (session_id, transcript, normalized, stt_confidence, model, prompt_version, tool_call, grounding, response, lang)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [session.id, transcript, normalized[normalized.length - 1], req.confidence ?? null, config.model, prompt.version,
      JSON.stringify(call), JSON.stringify(grounding), JSON.stringify(response, bigintJson), lang]);
  return response;
}

async function createSession(db: Db, companyId: string, lang: Lang): Promise<Session> {
  const r = await one<{ id: string }>(db, `INSERT INTO voice_sessions (company_id, lang) VALUES ($1, $2) RETURNING id`, [companyId, lang]);
  return { id: r.id, status: 'OPEN', kind: null, lang, transcripts: [], last_call: null, draft_id: null, draft_hash: null, target_voucher_id: null, readback_at: null, total_minor: null };
}

async function loadSession(db: Db, companyId: string, id: string): Promise<Session | null> {
  return maybeOne<Session>(db,
    `SELECT id, status, kind, lang, transcripts, last_call, draft_id, draft_hash, target_voucher_id, readback_at, total_minor
       FROM voice_sessions WHERE id = $1 AND company_id = $2`, [id, companyId]);
}

async function keepAsking(t: Turn, call: RecordVoucherCall | null, question: string): Promise<VoiceResponse> {
  await t.db.query(
    `UPDATE voice_sessions SET transcripts = $2, last_call = $3, readback_at = NULL, updated_at = now() WHERE id = $1`,
    [t.s.id, JSON.stringify(t.transcripts), call ? JSON.stringify(call) : null]);
  // A Tanglish reply is spoken by an English voice, which cannot read Tamil script.
  const speech = t.lang === 'tanglish' && hasTamil(question) ? t.T.sayAgain : question;
  return { kind: 'clarify', sessionId: t.s.id, lang: t.lang, speech };
}

async function closeSession(t: Turn) {
  await t.db.query(`UPDATE voice_sessions SET status = 'CANCELLED', updated_at = now() WHERE id = $1`, [t.s.id]);
}

function pick<T extends { key: string; id: string }>(list: T[], ref: EntityRef | null): T | null {
  if (!ref?.candidate_id) return null;
  return list.find((c) => c.key === ref.candidate_id) ?? null;
}

async function recordVoucher(t: Turn, call: RecordVoucherCall, c: VoiceCandidates, combined: string): Promise<VoiceResponse> {
  const { db, ctx, s, T } = t;
  const ask = (q: string) => keepAsking(t, call, q);
  const today = todayIST();
  const date = call.date ?? today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return ask(T.whichDate);
  if (date > today) return ask(T.futureDate(T.date(date)));

  const party = pick(c.parties, call.party);
  if (call.party && !party) {
    const similar = c.parties.slice(0, 2).map((p) => `${p.name}${p.city ? ` (${p.city})` : ''}`);
    return ask(similar.length ? T.didYouMean(similar) : T.partyNotFound(call.party.spoken));
  }
  const other = pick(c.ledgers, call.other_ledger);
  if (call.other_ledger && !other) return ask(T.whichLedger(call.other_ledger.spoken));

  let input: VoucherInputRaw;
  const type = call.voucher_type;
  if (type === 'SALES' || type === 'PURCHASE' || type === 'CREDIT_NOTE' || type === 'DEBIT_NOTE') {
    let mode = call.payment_mode;
    if (mode === 'UNSPECIFIED') {
      if (!party) return ask(T.cashOrCredit);
      mode = 'CREDIT';
    }
    if (mode === 'CREDIT' && !party) return ask(type === 'PURCHASE' ? T.whichSupplier : T.whichCustomer);
    let bankLedgerId: string | null = null;
    if (mode === 'BANK') {
      const banks = ctx.bankLedgers();
      bankLedgerId = other && ctx.isCashBank(other.id) ? other.id : banks.length === 1 ? banks[0].id : null;
      if (!bankLedgerId) return ask(T.whichBank);
    }
    const items: NonNullable<VoucherInputRaw['items']> = [];
    for (const [i, it] of call.items.entries()) {
      const item = pick(c.items, it.entity);
      if (!item) return ask(T.whichItem(it.entity?.spoken ?? `${i + 1}`));
      if (!it.quantity) return ask(T.howMany(item.uom, item.name));
      const gst = call.gst_rate_percent ?? (item.gstRatePpm !== null ? String(item.gstRatePpm / 10_000) : null);
      if (gst === null) return ask(T.gstFor(item.name));
      let amount: string | null = null;
      if (call.items.length === 1 && call.amount) amount = call.amount.value;
      else if (it.rate) amount = new Decimal(it.quantity.value).times(it.rate.value).toFixed(2);
      if (!amount) return ask(call.items.length > 1 ? T.rateFor(item.name) : T.whatAmount);
      items.push({ itemId: item.id, qty: it.quantity.value, rate: it.rate?.value ?? null, amount, gstRate: gst, description: item.name });
    }
    if (!items.length) {
      if (!call.amount) return ask(T.whatAmount);
      const gst = call.gst_rate_percent;
      if (gst === null) return ask(T.whatGst);
      items.push({ amount: call.amount.value, gstRate: gst, description: call.narration ?? null, ledgerId: other && !ctx.isCashBank(other.id) ? other.id : null });
    }
    const anyTax = items.some((i) => percentToPpm(i.gstRate ?? '0') > 0);
    if (anyTax && call.amount_includes_tax === null && (call.amount || call.items.some((i) => i.rate))) {
      return ask(T.inclusive(call.amount ? call.amount.value : null));
    }
    // A credit purchase must carry the supplier's bill number (GST input credit is claimed against it).
    if (type === 'PURCHASE' && mode === 'CREDIT' && !call.bill_no) return ask(T.billNo(party?.name ?? null));
    input = {
      voucherType: type, date, counterpartyId: party?.id ?? null, paymentMode: mode, bankLedgerId,
      pricesIncludeTax: Boolean(call.amount_includes_tax), items, narration: call.narration ?? null,
      partyRefNo: call.bill_no ?? null,
    };
  } else if (type === 'PAYMENT' || type === 'RECEIPT') {
    if (!call.amount) return ask(T.whatAmount);
    const counter = party ? ctx.partyLedger(party.id).id : other && !ctx.isCashBank(other.id) ? other.id : null;
    if (!counter) return ask(type === 'PAYMENT' ? T.whoPaymentFor : T.whoReceivedFrom);
    let money: string | null = null;
    if (call.payment_mode === 'CASH') money = ctx.systemLedger('CASH').id;
    else if (call.payment_mode === 'BANK' || (other && ctx.isCashBank(other.id))) {
      const banks = ctx.bankLedgers();
      money = other && ctx.isCashBank(other.id) ? other.id : banks.length === 1 ? banks[0].id : null;
      if (!money) return ask(T.whichBank);
    } else return ask(T.cashOrBank);
    input = {
      voucherType: type, date, narration: call.narration ?? null,
      entries: type === 'PAYMENT'
        ? [{ ledgerId: counter, side: 'DR', amount: call.amount.value }, { ledgerId: money, side: 'CR', amount: call.amount.value }]
        : [{ ledgerId: money, side: 'DR', amount: call.amount.value }, { ledgerId: counter, side: 'CR', amount: call.amount.value }],
    };
  } else if (type === 'CONTRA') {
    if (!call.amount) return ask(T.whatAmount);
    const bank = other && ctx.isCashBank(other.id) && other.id !== ctx.systemLedger('CASH').id ? other.id : ctx.bankLedgers().length === 1 ? ctx.bankLedgers()[0].id : null;
    if (!bank) return ask(T.whichBank);
    const withdraw = /withdr|nikal|nikaal|எடுத்தேன்|எடு/i.test(combined);
    const cash = ctx.systemLedger('CASH').id;
    input = {
      voucherType: 'CONTRA', date, narration: call.narration ?? (withdraw ? 'Cash withdrawn' : 'Cash deposited'),
      entries: [
        { ledgerId: withdraw ? cash : bank, side: 'DR', amount: call.amount.value },
        { ledgerId: withdraw ? bank : cash, side: 'CR', amount: call.amount.value },
      ],
    };
  } else {
    return ask(T.journalOnScreen);
  }

  let preview: Awaited<ReturnType<typeof previewVoucher>>;
  try {
    preview = await previewVoucher(db, ctx.company.id, input);
  } catch (e) {
    if (e instanceof AppError) return ask(T.previewError(e.message));
    throw e;
  }

  const warnings = [...preview.warnings.map((w) => w.message)];
  const dup = await maybeOne<{ voucher_no: string; minutes: number }>(db,
    `SELECT v.voucher_no, EXTRACT(EPOCH FROM (now() - v.posted_at))::int / 60 AS minutes
       FROM vouchers v JOIN voucher_types t ON t.id = v.voucher_type_id
      WHERE v.company_id = $1 AND t.base_type = $2 AND v.total_minor = $3
        AND v.counterparty_id IS NOT DISTINCT FROM $4 AND v.posted_at > now() - interval '10 minutes'
      ORDER BY v.posted_at DESC LIMIT 1`, [ctx.company.id, type, preview.totalMinor, (input.counterpartyId as string | null) ?? null]);
  if (dup) warnings.push(T.duplicate(type, dup.minutes, dup.voucher_no));
  const backdated = daysBetween(date, today) > 7;
  const overLimit = preview.totalMinor > ctx.company.voice_limit_minor;
  const needsScreenConfirm = backdated || overLimit;

  const readback = buildReadback(T, type, input, preview, party?.name ?? null, ctx, date, today, warnings, needsScreenConfirm, overLimit);
  const draftHash = crypto.createHash('sha256').update(stableStringify(input)).digest('hex');
  let draftId = s.draft_id;
  if (draftId) {
    await db.query(`UPDATE voucher_drafts SET payload = $2, updated_at = now() WHERE id = $1`, [draftId, JSON.stringify(input)]);
  } else {
    draftId = (await one<{ id: string }>(db,
      `INSERT INTO voucher_drafts (company_id, payload, source, source_ref, created_by) VALUES ($1,$2,'VOICE',$3,$4) RETURNING id`,
      [ctx.company.id, JSON.stringify(input), s.id, t.userId])).id;
  }
  const readbackAt = new Date();
  await db.query(
    `UPDATE voice_sessions SET kind = 'VOUCHER', transcripts = $2, last_call = $3, draft_id = $4, draft_hash = $5,
            readback = $6, readback_at = $7, total_minor = $8, updated_at = now() WHERE id = $1`,
    [s.id, JSON.stringify(t.transcripts), JSON.stringify(call), draftId, draftHash, readback, readbackAt.toISOString(), preview.totalMinor]);

  return {
    kind: 'voucher', sessionId: s.id, lang: t.lang, speech: readback,
    draft: {
      draftId, input, preview, warnings, needsScreenConfirm, overLimit, backdated,
      expiresAt: new Date(readbackAt.getTime() + CONFIRM_WINDOW_MS).toISOString(),
    },
  };
}

/**
 * Grounding accepts "5,500" as 5500; drop the grouping commas so the amounts reach the posting engine as
 * plain decimals (it, and Decimal, reject commas).
 */
function plainNumbers(node: unknown): void {
  if (Array.isArray(node)) { node.forEach(plainNumbers); return; }
  if (!node || typeof node !== 'object') return;
  const o = node as Record<string, unknown>;
  if (typeof o.value === 'string' && /^\d{1,3}(,\d{2,3})+(\.\d+)?$/.test(o.value)) o.value = o.value.replace(/,/g, '');
  for (const v of Object.values(o)) if (v && typeof v === 'object') plainNumbers(v);
}

function buildReadback(
  T: Messages, type: string, input: VoucherInputRaw, preview: Awaited<ReturnType<typeof previewVoucher>>, partyName: string | null,
  ctx: LedgerContext, date: string, today: string, warnings: string[], needsScreen: boolean, overLimit: boolean,
): string {
  const parts: string[] = [];
  const total = T.money(preview.totalMinor);
  const ledgerName = (id: string) => ctx.ledger(id).name;
  if (type === 'SALES' || type === 'PURCHASE' || type === 'CREDIT_NOTE' || type === 'DEBIT_NOTE') {
    parts.push(T.tradingHeader(type, input.paymentMode ?? 'CREDIT', partyName));
    const lines = (input.items ?? []).map((i) => (i.qty ? `${i.qty} ${i.description ?? ''}`.trim() : i.description)).filter((x): x is string => Boolean(x));
    if (lines.length) parts.push(T.lines(lines));
    parts.push(preview.taxMinor > 0n ? T.totalWithGst(total, T.money(preview.taxMinor)) : T.totalNoGst(total));
  } else {
    const [a, b] = input.entries ?? [];
    if (type === 'PAYMENT') parts.push(T.payment(total, ledgerName(a.ledgerId), ledgerName(b.ledgerId)));
    else if (type === 'RECEIPT') parts.push(T.receipt(total, ledgerName(b.ledgerId), ledgerName(a.ledgerId)));
    else parts.push(T.transfer(total, ledgerName(b.ledgerId), ledgerName(a.ledgerId)));
  }
  if (date !== today) parts.push(T.dated(T.date(date)));
  for (const w of warnings) parts.push(T.note(w));
  parts.push(needsScreen ? (overLimit ? T.overLimit : T.backdated) : T.sayConfirm);
  return parts.join(' ');
}

export async function confirmSession(
  db: PGlite, companyId: string, sessionId: string, channel: 'voice' | 'screen', langHint?: Lang | null, userId: string = config.localUserId,
): Promise<VoiceResponse> {
  const s = await loadSession(db, companyId, sessionId);
  const lang: Lang = langHint ?? s?.lang ?? 'en';
  const T = msgs(lang);
  if (!s || s.status !== 'OPEN' || !s.readback_at) throw new AppError('NOTHING_TO_CONFIRM', 409, T.nothingToConfirm);
  const company = await one<{ voice_limit_minor: bigint }>(db, `SELECT voice_limit_minor FROM companies WHERE id = $1`, [companyId]);
  if (channel === 'voice' && Date.now() - new Date(s.readback_at).getTime() > CONFIRM_WINDOW_MS) {
    throw new AppError('CONFIRM_EXPIRED', 409, T.confirmExpired);
  }

  if (s.kind === 'REVERSE' && s.target_voucher_id) {
    // The same limits as posting: a large or old voucher is only reversed with Ctrl+A on screen.
    if (channel === 'voice') {
      const target = await one<{ total_minor: bigint; voucher_date: string }>(db,
        `SELECT total_minor, voucher_date::text FROM vouchers WHERE id = $1 AND company_id = $2`, [s.target_voucher_id, companyId]);
      if (target.total_minor > company.voice_limit_minor) throw new AppError('NEEDS_SCREEN_CONFIRM', 409, T.overLimitConfirm);
      if (daysBetween(target.voucher_date, todayIST()) > 7) throw new AppError('NEEDS_SCREEN_CONFIRM', 409, T.backdatedConfirm);
    }
    const r = await reverseVoucher(db, companyId, s.target_voucher_id, { userId, source: 'VOICE', idempotencyKey: `voice-reverse:${s.id}` });
    await db.query(`UPDATE voice_sessions SET status = 'POSTED', voucher_id = $2, updated_at = now() WHERE id = $1`, [s.id, r.id]);
    return { kind: 'posted', sessionId: null, lang, speech: T.reversed(r.voucherNo), voucher: { id: r.id, voucherNo: r.voucherNo, voucherType: r.voucherType } };
  }
  if (!s.draft_id || !s.draft_hash) throw new AppError('NOTHING_TO_CONFIRM', 409, T.nothingToConfirm);
  const draft = await one<{ payload: VoucherInputRaw }>(db, `SELECT payload FROM voucher_drafts WHERE id = $1`, [s.draft_id]);
  const hash = crypto.createHash('sha256').update(stableStringify(draft.payload)).digest('hex');
  if (hash !== s.draft_hash) throw new AppError('DRAFT_CHANGED', 409, T.draftChanged);
  if (channel === 'voice' && s.total_minor !== null && s.total_minor > company.voice_limit_minor) {
    throw new AppError('NEEDS_SCREEN_CONFIRM', 409, T.overLimitConfirm);
  }
  if (channel === 'voice' && daysBetween(draft.payload.date, todayIST()) > 7) {
    throw new AppError('NEEDS_SCREEN_CONFIRM', 409, T.backdatedConfirm);
  }
  const posted = await postVoucher(db, companyId, { ...draft.payload, confirmWarnings: true },
    { source: 'VOICE', idempotencyKey: `voice:${s.id}:${s.draft_hash}`, userId, draftId: s.draft_id });
  await db.query(`UPDATE voice_sessions SET status = 'POSTED', voucher_id = $2, updated_at = now() WHERE id = $1`, [s.id, posted.id]);
  return {
    kind: 'posted', sessionId: null, lang,
    speech: posted.alreadyPosted ? T.alreadyPosted(posted.voucherType, posted.voucherNo) : T.posted(posted.voucherType, posted.voucherNo),
    voucher: { id: posted.id, voucherNo: posted.voucherNo, voucherType: posted.voucherType },
  };
}

export async function cancelSession(db: Db, companyId: string, sessionId: string, langHint?: Lang | null): Promise<VoiceResponse> {
  const s = await loadSession(db, companyId, sessionId);
  const lang: Lang = langHint ?? s?.lang ?? 'en';
  if (s && s.status === 'OPEN') {
    await db.query(`UPDATE voice_sessions SET status = 'CANCELLED', updated_at = now() WHERE id = $1`, [s.id]);
    if (s.draft_id) await db.query(`UPDATE voucher_drafts SET status = 'DISCARDED', updated_at = now() WHERE id = $1 AND status = 'OPEN'`, [s.draft_id]);
  }
  return { kind: 'cancelled', sessionId: null, lang, speech: msgs(lang).cancelled };
}

async function queryOutstanding(t: Turn, q: { side: 'RECEIVABLE' | 'PAYABLE'; party: EntityRef | null; period: PeriodName }, c: VoiceCandidates): Promise<VoiceResponse> {
  const { db, ctx, T } = t;
  const party = pick(c.parties, q.party);
  const today = todayIST();
  if (!party) {
    if (q.party) return keepAsking(t, null, T.whichPartyBy(q.party.spoken));
    const a = await ageing(db, ctx.company.id, q.side === 'RECEIVABLE' ? 'receivable' : 'payable', today);
    await closeSession(t);
    const amount = T.money(a.totals.total);
    return { kind: 'answer', sessionId: null, lang: t.lang, speech: q.side === 'RECEIVABLE' ? T.customersOwe(amount) : T.youOweSuppliers(amount), data: a.totals };
  }
  const period = resolvePeriod(q.period, today, ctx.company.fy_start_month);
  const o = await partyOutstanding(db, ctx.company.id, party.id, today, period.from);
  await closeSession(t);
  const abs = (v: bigint) => (v < 0n ? -v : v);
  const parts: string[] = [];
  if (o.balanceMinor > 0n) parts.push(T.partyOwes(party.name, T.money(o.balanceMinor)));
  else if (o.balanceMinor < 0n) parts.push(T.youOweParty(party.name, T.money(-o.balanceMinor)));
  else parts.push(T.noBalance(party.name));
  if (o.balanceMinor !== 0n && q.period !== 'AS_OF_TODAY') {
    parts.push(T.fromBillsSince(T.money(abs(o.inPeriodMinor)), T.period(q.period), T.date(period.from)));
  }
  if (o.over60Minor !== 0n) parts.push(T.overdue60(T.money(abs(o.over60Minor))));
  return { kind: 'answer', sessionId: null, lang: t.lang, speech: parts.join(' '), data: { party: party.name, period, ...o } };
}

async function queryReport(t: Turn, q: { metric: string; period: PeriodName }): Promise<VoiceResponse> {
  const { db, ctx, T } = t;
  const today = todayIST();
  const periodName: PeriodName = q.period === 'AS_OF_TODAY' ? 'THIS_FY' : q.period;
  const p = resolvePeriod(periodName, today, ctx.company.fy_start_month);
  const label = T.period(periodName);
  const id = ctx.company.id;
  let speech: string;
  let value: bigint;
  switch (q.metric) {
    case 'SALES_TOTAL': value = await typeTotal(db, id, 'SALES', p.from, p.to); speech = T.sales(label, T.money(value)); break;
    case 'PURCHASE_TOTAL': value = await typeTotal(db, id, 'PURCHASE', p.from, p.to); speech = T.purchases(label, T.money(value)); break;
    case 'GST_PAYABLE':
      value = (await gstSummary(db, id, p.from, p.to)).netPayableMinor;
      speech = value >= 0n ? T.gstPayable(label, T.money(value)) : T.excessItc(label, T.money(-value));
      break;
    case 'CASH_BALANCE': value = await cashBalance(db, id, p.to); speech = T.cash(T.money(value)); break;
    case 'BANK_BALANCE': value = await bankBalance(db, id, p.to); speech = T.bank(T.money(value)); break;
    case 'NET_PROFIT':
      value = (await profitAndLoss(db, id, p.from, p.to)).netProfitMinor;
      speech = value >= 0n ? T.profit(label, T.money(value)) : T.loss(label, T.money(-value));
      break;
    case 'RECEIVABLES_TOTAL': value = (await ageing(db, id, 'receivable', today)).totals.total; speech = T.customersOwe(T.money(value)); break;
    case 'PAYABLES_TOTAL': value = (await ageing(db, id, 'payable', today)).totals.total; speech = T.youOweSuppliers(T.money(value)); break;
    default: return keepAsking(t, null, T.whichFigure);
  }
  await closeSession(t);
  return { kind: 'answer', sessionId: null, lang: t.lang, speech, data: { metric: q.metric, period: p, valueMinor: value } };
}

async function navigate(t: Turn, q: { screen: string; period: PeriodName; ledger: EntityRef | null }, c: VoiceCandidates): Promise<VoiceResponse> {
  const { ctx, T } = t;
  const today = todayIST();
  const p = q.period === 'UNSPECIFIED'
    ? (['DAYBOOK'].includes(q.screen) ? resolvePeriod('TODAY', today) : resolvePeriod('THIS_FY', today, ctx.company.fy_start_month))
    : resolvePeriod(q.period, today, ctx.company.fy_start_month);
  let ledgerId: string | null = null;
  if (q.screen === 'LEDGER') {
    const party = pick(c.parties, q.ledger);
    const ledger = pick(c.ledgers, q.ledger);
    ledgerId = party ? ctx.partyLedger(party.id).id : ledger?.id ?? null;
    if (!ledgerId) return keepAsking(t, null, T.whichLedgerOpen);
  }
  await closeSession(t);
  return {
    kind: 'navigate', sessionId: null, lang: t.lang,
    speech: T.opening(T.screen(q.screen), q.period !== 'UNSPECIFIED' ? T.period(q.period) : null),
    route: { screen: q.screen, from: p.from, to: p.to, ledgerId },
  };
}

async function prepareReverse(t: Turn, q: { voucher_type: string; voucher_no: string | null }): Promise<VoiceResponse> {
  const { db, ctx, s, T } = t;
  const v = await maybeOne<{ id: string; voucher_no: string; voucher_date: string; total_minor: bigint; party: string | null }>(db,
    `SELECT v.id, v.voucher_no, v.voucher_date::text, v.total_minor, cp.legal_name AS party
       FROM vouchers v JOIN voucher_types t ON t.id = v.voucher_type_id LEFT JOIN counterparties cp ON cp.id = v.counterparty_id
      WHERE v.company_id = $1 AND t.base_type = $2 AND ($3::text IS NULL OR v.voucher_no = $3)
        AND v.reverses_voucher_id IS NULL AND NOT EXISTS (SELECT 1 FROM vouchers r WHERE r.reverses_voucher_id = v.id)
      ORDER BY v.chain_seq DESC LIMIT 1`, [ctx.company.id, q.voucher_type, q.voucher_no]);
  const label = T.voucher(q.voucher_type);
  if (!v) return keepAsking(t, null, T.voucherNotFound(label, q.voucher_no));
  const speech = T.reverseQuestion(label, v.voucher_no, T.date(v.voucher_date), T.money(v.total_minor), v.party);
  const at = new Date();
  await db.query(
    `UPDATE voice_sessions SET kind = 'REVERSE', transcripts = $2, target_voucher_id = $3, readback = $4, readback_at = $5, total_minor = $6, updated_at = now() WHERE id = $1`,
    [s.id, JSON.stringify(t.transcripts), v.id, speech, at.toISOString(), v.total_minor]);
  return { kind: 'reverse', sessionId: s.id, lang: t.lang, speech, target: { id: v.id, voucherNo: v.voucher_no, date: v.voucher_date, totalMinor: v.total_minor, party: v.party }, expiresAt: new Date(at.getTime() + CONFIRM_WINDOW_MS).toISOString() };
}
