import { useCallback, useEffect, useRef, useState } from 'react';
import { api, c, ApiError, type Preview } from '../api';
import { useApp, type Route } from '../state';
import { useKeys } from '../keys';
import { Kbd } from './ui';
import { SpeechNotice } from './Privacy';
import { inr } from '../format';

type VLang = 'en' | 'ta' | 'tanglish';

/** Speech-recognition and speech-synthesis locales, plus example commands, per voice language. */
const LANGS: Record<VLang, { label: string; short: string; stt: string; tts: string; examples: string[]; typeHint: string; yes: string; no: string }> = {
  en: {
    label: 'English / Hinglish', short: 'English', stt: 'en-IN', tts: 'en-IN',
    examples: [
      'Cash sale of 5,500 rupees to Rajesh Traders for 10 bags of cement including 18% GST',
      'How much does ABC Corp owe this quarter?',
      'Show yesterday’s day book',
    ],
    typeHint: 'Type or tap the mic…', yes: 'Confirm', no: 'Cancel',
  },
  ta: {
    label: 'தமிழ் (Tamil)', short: 'தமிழ்', stt: 'ta-IN', tts: 'ta-IN',
    examples: [
      'ராஜேஷ் டிரேடர்ஸ்-க்கு பத்து மூட்டை சிமெண்ட் ரொக்க விற்பனை, ஐயாயிரத்து ஐநூறு ரூபாய், 18% ஜிஎஸ்டி சேர்த்து',
      'ABC Corp இந்த காலாண்டு எவ்வளவு பாக்கி?',
      'நேற்றைய நாள் புத்தகத்தைக் காட்டு',
    ],
    typeHint: 'தட்டச்சு செய்யுங்கள் அல்லது மைக்கை அழுத்துங்கள்…',
    yes: 'சரி', no: 'வேண்டாம்',
  },
  tanglish: {
    // Listens in Tamil; replies in Tamil written in English letters, spoken by the Indian English voice.
    label: 'Tanglish (Tamil + English)', short: 'Tanglish', stt: 'ta-IN', tts: 'en-IN',
    examples: [
      'Rajesh Traders-ku 10 bag cement cash sale, 5500 rupees, 18% GST serthu',
      'ABC Corp indha quarter evvalavu baaki?',
      'Nethu day book kaattu',
    ],
    typeHint: 'Type pannunga illa mic-ah tap pannunga…', yes: 'Sari, post', no: 'Vendam',
  },
};
const LANG_KEY = 'kannaku.voiceLang';
const MUTE_KEY = 'kannaku.voiceMuted';
const loadLang = (): VLang => { try { const v = localStorage.getItem(LANG_KEY); return v === 'ta' || v === 'tanglish' ? v : 'en'; } catch { return 'en'; } };
const saveLang = (l: VLang) => { try { localStorage.setItem(LANG_KEY, l); } catch { /* storage blocked */ } };
const loadMuted = () => { try { return localStorage.getItem(MUTE_KEY) === '1'; } catch { return false; } };
const saveMuted = (m: boolean) => { try { localStorage.setItem(MUTE_KEY, m ? '1' : '0'); } catch { /* storage blocked */ } };
// Off until the user turns it on and agrees to the notice. A new key, so installs where it used to be on
// by default start with it off.
const WAKE_KEY = 'kannaku.wakeWord.v2';
const loadWake = () => { try { return localStorage.getItem(WAKE_KEY) === '1'; } catch { return false; } };
const saveWake = (w: boolean) => { try { localStorage.setItem(WAKE_KEY, w ? '1' : '0'); } catch { /* storage blocked */ } };
// Agreement to the microphone notices (components/Privacy.tsx). Without storage it is asked again next time.
const MIC_CONSENT_KEY = 'kannaku.micConsent.v1';
const WAKE_CONSENT_KEY = 'kannaku.wakeConsent.v1';
const hasConsent = (k: string) => { try { return localStorage.getItem(k) === '1'; } catch { return false; } };
const saveConsent = (k: string) => { try { localStorage.setItem(k, '1'); } catch { /* storage blocked */ } };

/** Hands-free, a bare "yes" may be someone else talking nearby; posting needs the wake word too. */
const HANDS_FREE_CONFIRM: Record<VLang, string> = {
  en: 'To post hands-free, say “Kannaku, confirm”, or press Ctrl+A.',
  ta: 'பதிவு செய்ய “கணக்கு சரி” என்று சொல்லுங்கள், அல்லது Ctrl+A அழுத்தவும்.',
  tanglish: 'Post panna “Kannaku sari” sollunga, illa Ctrl+A press pannunga.',
};

/**
 * "Kannaku" as speech recognition writes it in English and Tamil. It only counts at the start of
 * what was said ("Kannaku, ABC Corp evvalavu baaki?"), because கணக்கு is also an everyday word.
 */
const WAKE_WORDS = [
  'kannaku', 'kanaku', 'kanakku', 'kannakku', 'kannagu', 'kanagu', 'kannaaku', 'canaku', 'cannaku', 'kanaka', 'kannaka',
  'கணக்கு', 'கண்ணக்கு', 'கன்னக்கு', 'கனக்கு', 'கண்ணாக்கு', 'கணக்கே',
];
const WAKE_RE = new RegExp('^\\s*(?:(?:hey|hi|ok|okay|ஹே|ஏய்|ஹாய்)[\\s,]+)?(?:' + WAKE_WORDS.join('|') + ')(?:[\\s,.!?]+(.*))?$', 'i');
export const wakeCommand = (heard: string): string | null => {
  const m = WAKE_RE.exec(heard.trim());
  return m ? (m[1] ?? '').trim() : null;
};

function pickVoice(voices: SpeechSynthesisVoice[], locale: string): SpeechSynthesisVoice | null {
  const norm = (x: string) => x.replace('_', '-').toLowerCase();
  const want = norm(locale);
  return voices.find((v) => norm(v.lang) === want) ?? voices.find((v) => norm(v.lang).startsWith(want.slice(0, 2))) ?? null;
}

type VoiceResponse =
  | { kind: 'voucher'; sessionId: string; lang?: VLang; speech: string; draft: { preview: Preview; warnings: string[]; needsScreenConfirm: boolean; expiresAt: string } }
  | { kind: 'reverse'; sessionId: string; lang?: VLang; speech: string; expiresAt: string; target: { voucherNo: string } }
  | { kind: 'clarify'; sessionId: string; lang?: VLang; speech: string }
  | { kind: 'answer'; sessionId: null; lang?: VLang; speech: string }
  | { kind: 'navigate'; sessionId: null; lang?: VLang; speech: string; route: { screen: string; from: string; to: string; ledgerId: string | null } }
  | { kind: 'posted'; sessionId: null; lang?: VLang; speech: string; voucher: { id: string } }
  | { kind: 'cancelled'; sessionId: null; lang?: VLang; speech: string };

// Same fixed grammar as the server (server/src/ai/voice/engine.ts): English, Hinglish, Tamil.
const END = '[.!]?' + '$';
const CONFIRM_RE = new RegExp('^(' + [
  'yes', 'yeah', 'yep', 'confirm(ed)?', 'post( it)?', 'ok(ay)?( post( it)?)?', 'do it', 'correct',
  'haan( ji)?', 'han', 'ha', 'ji haan', 'haan post karo', 'post karo', 'theek hai', 'sahi hai',
  'சரி', 'சரிங்க', 'சரி போடு', 'ஆமா', 'ஆமாம்', 'ஆம்', 'ஓகே', 'ஓக்கே', 'போடு', 'போடுங்க', 'பதிவு செய்', 'பதிவு செய்யுங்கள்', 'பதிவு பண்ணு', 'கன்ஃபார்ம்',
  'sari', 'seri', 'saringa', 'aama', 'aamaa', 'aamam', 'podu', 'podunga', 'pathivu sei',
].join('|') + ')' + END, 'i');
const CANCEL_RE = new RegExp('^(' + [
  'no', 'nope', 'cancel( it)?', 'stop', 'discard', 'nahi', 'nahin', 'mat karo', 'rehne do', 'chhodo',
  'வேண்டாம்', 'வேணாம்', 'ரத்து', 'ரத்து செய்', 'கேன்சல்', 'இல்லை', 'இல்ல', 'நிறுத்து',
  'vendam', 'venam', 'vendaam', 'rathu', 'illa', 'illai',
].join('|') + ')' + END, 'i');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const SR: any = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;

function routeFor(r: { screen: string; from: string; to: string; ledgerId: string | null }): Route {
  const map: Record<string, Route> = {
    DAYBOOK: { screen: 'daybook', params: { from: r.from, to: r.to } },
    TRIAL_BALANCE: { screen: 'tb' }, PROFIT_LOSS: { screen: 'pl' }, BALANCE_SHEET: { screen: 'bs' },
    LEDGER: { screen: 'ledger', params: { ledgerId: r.ledgerId, from: r.from, to: r.to } },
    AGEING_RECEIVABLE: { screen: 'ageing', params: { side: 'receivable' } }, AGEING_PAYABLE: { screen: 'ageing', params: { side: 'payable' } },
    STOCK_SUMMARY: { screen: 'stock' }, GST_SUMMARY: { screen: 'gst' }, REVIEW_QUEUE: { screen: 'review' }, DASHBOARD: { screen: 'gateway' },
  };
  return map[r.screen] ?? { screen: 'gateway' };
}

interface ChatMsg { id: number; who: 'you' | 'ai'; text: string; lang: VLang; error?: boolean }
let msgSeq = 0;

export function VoicePanel({ open, onOpen, onClose, onWakeChange }: { open: boolean; onOpen: () => void; onClose: () => void; onWakeChange?: (on: boolean) => void }) {
  const app = useApp();
  const [log, setLog] = useState<ChatMsg[]>([]);
  const [interim, setInterim] = useState('');
  const [listening, setListening] = useState(false);
  const [busy, setBusy] = useState(false);
  const [speakingId, setSpeakingId] = useState<number | null>(null);
  const [pending, setPending] = useState<Extract<VoiceResponse, { kind: 'voucher' | 'reverse' }> | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [lang, setLangState] = useState<VLang>(loadLang);
  const [muted, setMutedState] = useState(loadMuted);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [micOk, setMicOk] = useState(() => hasConsent(MIC_CONSENT_KEY));
  const [wakeOk, setWakeOk] = useState(() => hasConsent(WAKE_CONSENT_KEY));
  const [askConsent, setAskConsent] = useState<{ wake: boolean; then: () => void } | null>(null);
  const [wakeOn, setWakeOn] = useState(() => Boolean(SR) && loadWake() && hasConsent(MIC_CONSENT_KEY) && hasConsent(WAKE_CONSENT_KEY));
  const [wakeActive, setWakeActive] = useState(false);
  const [wakeErr, setWakeErr] = useState<string | null>(null);
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');
  // Refs, so a callback made before the user agreed still sees the agreement.
  const micOkRef = useRef(micOk);
  micOkRef.current = micOk;
  const wakeOkRef = useRef(wakeOk);
  wakeOkRef.current = wakeOk;
  /** This conversation was started by the wake word, not by a click, key or typing. */
  const handsFree = useRef(false);
  const rec = useRef<any>(null);
  const wakeRec = useRef<any>(null);
  const audio = useRef<AudioContext | null>(null);
  const openRef = useRef(onOpen);
  openRef.current = onOpen;
  const finals = useRef<{ text: string; conf: number }[]>([]);
  const logRef = useRef<HTMLDivElement>(null);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const handleRef = useRef<(text: string, conf: number | null, viaWake?: boolean) => Promise<void>>(async () => {});
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;
  const langRef = useRef(lang);
  langRef.current = lang;
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const voicesRef = useRef(voices);
  voicesRef.current = voices;
  const wakeOnRef = useRef(wakeOn);
  // Listening for the wake word only makes sense when the AI can answer, and only while this tab is in view.
  const wakeLive = wakeOn && app.status.aiEnabled && visible;
  wakeOnRef.current = wakeLive;
  useEffect(() => {
    const onVis = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  const setLang = (l: VLang) => { setLangState(l); saveLang(l); };
  const setMuted = (m: boolean) => { setMutedState(m); saveMuted(m); if (m) { window.speechSynthesis?.cancel(); setSpeakingId(null); } };
  const setWake = (w: boolean) => {
    // Turning it on needs agreement to the hands-free notice first.
    if (w && !(micOkRef.current && wakeOkRef.current)) { setAskConsent({ wake: true, then: () => setWake(true) }); return; }
    setWakeOn(w); saveWake(w); setWakeErr(null);
    // Created on this click, so the browser lets it play the "I'm listening" chime later.
    if (w && !audio.current && 'AudioContext' in window) audio.current = new AudioContext();
  };
  const agree = () => {
    if (!askConsent) return;
    setMicOk(true); micOkRef.current = true; saveConsent(MIC_CONSENT_KEY);
    if (askConsent.wake) { setWakeOk(true); wakeOkRef.current = true; saveConsent(WAKE_CONSENT_KEY); }
    setAskConsent(null);
    // Still inside the click, so the browser allows the microphone and the chime.
    askConsent.then();
  };
  /** Runs `start` now if the user has agreed to the microphone notice; otherwise shows the notice first. */
  const withMic = (start: () => void) => {
    handsFree.current = false;
    if (micOkRef.current) { start(); return; }
    if (!open) onOpen();
    setAskConsent({ wake: false, then: start });
  };
  const withMicRef = useRef(withMic);
  withMicRef.current = withMic;
  useEffect(() => { onWakeChange?.(wakeLive); }, [wakeLive, onWakeChange]);

  // The chime needs an AudioContext, which browsers allow only after the user has clicked or typed
  // somewhere on the page; create it on the first such interaction.
  useEffect(() => {
    const unlock = () => { if (!audio.current && 'AudioContext' in window) audio.current = new AudioContext(); };
    window.addEventListener('pointerdown', unlock, { once: true, capture: true });
    window.addEventListener('keydown', unlock, { once: true, capture: true });
    return () => { window.removeEventListener('pointerdown', unlock, true); window.removeEventListener('keydown', unlock, true); };
  }, []);


  /** Two short rising tones: "Kannaku" was heard, now say the command. */
  const chime = useCallback(() => {
    const ctx = audio.current;
    if (!ctx || mutedRef.current) return;
    void ctx.resume();
    [660, 880].forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = f;
      const t = ctx.currentTime + i * 0.12;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.15, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
      o.connect(g).connect(ctx.destination);
      o.start(t); o.stop(t + 0.12);
    });
  }, []);

  const stopWake = useCallback(() => {
    const w = wakeRec.current;
    wakeRec.current = null;       // onend sees this and does not restart
    setWakeActive(false);
    try { w?.abort(); } catch { /* already stopped */ }
  }, []);

  // Voices load asynchronously in Chrome and Edge.
  useEffect(() => {
    if (!('speechSynthesis' in window)) return;
    const load = () => setVoices(window.speechSynthesis.getVoices());
    load();
    window.speechSynthesis.addEventListener('voiceschanged', load);
    return () => window.speechSynthesis.removeEventListener('voiceschanged', load);
  }, []);

  // Keep the newest message in view.
  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' }); }, [log, interim, busy, pending]);

  /** Reads a message aloud in its language; with no voice for it (or muted) it is only shown. */
  const speak = useCallback((m: ChatMsg, then?: () => void) => {
    const synth = 'speechSynthesis' in window ? window.speechSynthesis : null;
    const locale = LANGS[m.lang].tts;
    const v = synth ? pickVoice(voicesRef.current.length ? voicesRef.current : synth.getVoices(), locale) : null;
    if (!synth || mutedRef.current || (!v && locale !== 'en-IN')) { then?.(); return; }
    synth.cancel();
    stopWake();                   // don't let the wake listener hear the reply
    const u = new SpeechSynthesisUtterance(m.text);
    u.lang = locale;
    if (v) u.voice = v;
    u.rate = m.lang === 'tanglish' ? 0.98 : 1.05;
    setSpeakingId(m.id);
    // Browsers sometimes never fire onend (a known Chrome bug); a timer makes sure the
    // conversation carries on (listening for the answer, or for "Kannaku") either way.
    let done = false;
    const finish = (runThen: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(guard);
      setSpeakingId((id) => (id === m.id ? null : id));
      if (runThen) then?.();
    };
    const guard = setTimeout(() => finish(true), Math.min(60_000, 3000 + m.text.length * 90));
    u.onend = () => finish(true);
    u.onerror = (e) => finish(e.error !== 'interrupted' && e.error !== 'canceled');
    synth.speak(u);
  }, [stopWake]);

  const say = useCallback((text: string, then?: () => void, replyLang?: VLang, error = false) => {
    const m: ChatMsg = { id: ++msgSeq, who: 'ai', text, lang: replyLang ?? langRef.current, error };
    setLog((l) => [...l, m]);
    speak(m, then);
  }, [speak]);

  /** endOnPause: stop when the speaker pauses (answers and wake-word commands); otherwise until stopped. */
  const startListening = useCallback((autoStopMs?: number, endOnPause = false) => {
    // Never turn the microphone on, even to hear an answer, before the user has agreed to the notice.
    if (!SR || rec.current || !micOkRef.current) return;
    stopWake();
    window.speechSynthesis?.cancel();
    setSpeakingId(null);
    const r = new SR();
    r.lang = LANGS[langRef.current].stt;
    r.interimResults = true;
    r.continuous = !endOnPause;
    finals.current = [];
    r.onresult = (e: any) => {
      let partial = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) finals.current.push({ text: res[0].transcript, conf: res[0].confidence });
        else partial += res[0].transcript;
      }
      setInterim(partial);
    };
    r.onend = () => {
      rec.current = null;
      setListening(false);
      setInterim('');
      const text = finals.current.map((f) => f.text).join(' ').trim();
      const conf = finals.current.length ? Math.min(...finals.current.map((f) => f.conf || 1)) : null;
      if (text) void handleRef.current(text, conf);
    };
    r.onerror = () => { rec.current = null; setListening(false); };
    rec.current = r;
    setListening(true);
    // start() throws if the previous recogniser has not quite let go of the microphone.
    try { r.start(); } catch { rec.current = null; setListening(false); return; }
    if (autoStopMs) setTimeout(() => rec.current === r && r.stop(), autoStopMs);
  }, [stopWake]);
  const stopListening = useCallback(() => rec.current?.stop(), []);

  const apply = useCallback((r: VoiceResponse) => {
    const replyLang = r.lang;
    switch (r.kind) {
      case 'voucher':
      case 'reverse':
        setPending(r); setSessionId(r.sessionId);
        // A conversation: after the readback, listen for "confirm" / "cancel" or a correction.
        say(r.speech, () => { if (r.kind === 'reverse' || !r.draft.needsScreenConfirm) startListening(10000, true); }, replyLang);
        break;
      case 'clarify':
        setSessionId(r.sessionId);
        say(r.speech, () => startListening(12000, true), replyLang);
        break;
      case 'navigate':
        setPending(null); setSessionId(null);
        app.go(routeFor(r.route));
        say(r.speech, undefined, replyLang);
        break;
      case 'posted':
        setPending(null); setSessionId(null);
        app.bumpData();
        say(r.speech, undefined, replyLang);
        break;
      default:
        setPending(null); setSessionId(null);
        say(r.speech, undefined, replyLang);
    }
  }, [app, say, startListening]);

  const confirm = useCallback(async (channel: 'voice' | 'screen') => {
    const p = pendingRef.current;
    if (!p) return;
    try { apply(await api.post<VoiceResponse>(c(`/voice/sessions/${p.sessionId}/confirm`), { channel, lang: langRef.current })); }
    catch (e) { say(e instanceof ApiError ? e.message : 'Could not post.', undefined, 'en', true); }
  }, [apply, say]);

  const cancel = useCallback(async () => {
    const p = pendingRef.current;
    if (!p) return;
    try { apply(await api.post<VoiceResponse>(c(`/voice/sessions/${p.sessionId}/cancel`), { lang: langRef.current })); }
    catch (e) { setPending(null); setSessionId(null); say(e instanceof ApiError ? e.message : 'Could not cancel.', undefined, 'en', true); }
  }, [apply, say]);

  /** viaWake: the wake word introduced this (it has already been taken off the text). */
  const handle = useCallback(async (text: string, confidence: number | null, viaWake = false) => {
    setLog((l) => [...l, { id: ++msgSeq, who: 'you', text, lang: langRef.current }]);
    const p = pendingRef.current;
    const addressed = wakeCommand(text);            // "Kannaku, sari" heard while listening for the answer
    const said = (addressed ?? text).trim();
    if (p && CONFIRM_RE.test(said)) {
      // Hands-free, a bare "sari" may be someone else talking near the computer; ask for the wake word with it.
      if (handsFree.current && !viaWake && addressed === null) { say(HANDS_FREE_CONFIRM[langRef.current]); return; }
      return confirm('voice');
    }
    if (p && CANCEL_RE.test(said)) return cancel();
    setBusy(true);
    try {
      apply(await api.post<VoiceResponse>(c('/voice/utterance'), {
        transcript: text, confidence, sessionId: sessionRef.current, screen: app.route.screen, lang: langRef.current,
      }));
    } catch (e) {
      say(e instanceof ApiError ? e.message : 'Something went wrong.', undefined, 'en', true);
    } finally { setBusy(false); }
  }, [app.route.screen, apply, cancel, confirm, say]);
  handleRef.current = handle;
  /** Typed, tapped or clicked: the user is at the screen, so this is not a hands-free conversation. */
  const byHand = (text: string) => { handsFree.current = false; void handle(text, null); };

  // ---------- "Kannaku" wake word ----------
  // A background recogniser that only looks for the wake word; it pauses while the assistant
  // listens to a command or speaks, and resumes when idle.
  const startWake = useCallback(() => {
    if (!SR || !wakeOnRef.current || !micOkRef.current || !wakeOkRef.current || wakeRec.current || rec.current) return;
    const r = new SR();
    r.lang = LANGS[langRef.current].stt;
    r.continuous = true;
    r.interimResults = false;
    const started = Date.now();
    r.onresult = (e: any) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (!e.results[i].isFinal) continue;
        const command = wakeCommand(e.results[i][0].transcript);
        if (command === null) continue;
        stopWake();
        openRef.current();
        handsFree.current = true;
        if (command.length > 1) void handleRef.current(command, e.results[i][0].confidence ?? null, true);
        else { chime(); setTimeout(() => startListening(10000, true), 250); }
        return;
      }
    };
    r.onerror = (e: any) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        setWakeOn(false); saveWake(false);
        setWakeErr('The browser blocked the microphone, so "Kannaku" cannot be heard. Allow the microphone for this site and switch it on again.');
      }
    };
    r.onend = () => {
      if (wakeRec.current !== r) return;      // stopped on purpose
      wakeRec.current = null;
      setWakeActive(false);
      // Browsers end long recognition sessions now and then; carry on, slower if it keeps failing.
      if (wakeOnRef.current) setTimeout(() => startWake(), Date.now() - started < 2000 ? 3000 : 300);
    };
    wakeRec.current = r;
    try { r.start(); setWakeActive(true); } catch { wakeRec.current = null; }
  }, [chime, startListening, stopWake]);

  // Resume waiting for "Kannaku" whenever the assistant is idle; stop when switched off.
  useEffect(() => {
    if (!wakeLive) { stopWake(); return; }
    if (listening || busy || speakingId !== null) return;
    const t = setTimeout(startWake, 500);
    return () => clearTimeout(t);
  }, [wakeLive, listening, busy, speakingId, lang, startWake, stopWake]);
  // A language change restarts the recogniser in the new language.
  useEffect(() => { stopWake(); }, [lang, stopWake]);
  useEffect(() => () => stopWake(), [stopWake]);

  // Hold Ctrl+Space to talk.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && (e.ctrlKey || e.metaKey) && !e.repeat) {
        e.preventDefault();
        if (!open) onOpen();
        withMicRef.current(() => startListening());
      }
    };
    const up = (e: KeyboardEvent) => { if ((e.code === 'Space' || e.key === 'Control') && rec.current) stopListening(); };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    return () => { window.removeEventListener('keydown', down, true); window.removeEventListener('keyup', up, true); };
  }, [open, onOpen, startListening, stopListening]);

  // Ctrl+A confirms the voice draft only while it is on screen; otherwise it belongs to the screen behind.
  useKeys({ 'Ctrl+A': () => { void confirm('screen'); } }, open && Boolean(pending));
  useKeys({ Escape: () => { onClose(); } }, open && !pending);
  // Closing the panel drops the draft it was showing, so nothing unseen can be confirmed later.
  useEffect(() => {
    const p = pendingRef.current;
    if (open || !p) return;
    setPending(null);
    setSessionId(null);
    void api.post(c(`/voice/sessions/${p.sessionId}/cancel`), { lang: langRef.current }).catch(() => {});
  }, [open]);

  if (!open) return null;
  const L = LANGS[lang];
  const preview = pending?.kind === 'voucher' ? pending.draft.preview : null;
  const noTamilVoice = lang === 'ta' && voices.length > 0 && !pickVoice(voices, 'ta-IN');
  const status = listening ? 'Listening…' : busy ? 'Thinking…' : speakingId !== null ? 'Speaking…'
    : wakeActive ? 'Say “Kannaku” to ask' : SR ? 'Tap the mic or hold Ctrl+Space' : 'Type a message';

  return (
    <aside className="voice chat" aria-label="Voice assistant" lang={lang === 'ta' ? 'ta' : 'en'}>
      <header className="chat-head">
        <div className={`chat-avatar ${listening ? 'listening' : speakingId !== null ? 'speaking' : ''}`} aria-hidden>K</div>
        <div className="chat-title">
          <strong>Kannaku assistant</strong>
          <span className="muted small">{status}</span>
        </div>
        <button className="ghost icon" onClick={() => setMuted(!muted)} aria-pressed={!muted}
          title={muted ? 'Replies are not read aloud. Click to turn the voice on' : 'Replies are read aloud. Click to mute'}>{muted ? '🔇' : '🔊'}</button>
        <button className="ghost icon" onClick={onClose} aria-label="Close voice panel">×</button>
      </header>

      <div className="lang-tabs" role="radiogroup" aria-label="Reply language">
        {(Object.keys(LANGS) as VLang[]).map((k) => (
          <button key={k} role="radio" aria-checked={lang === k} className={lang === k ? 'on' : ''} disabled={listening}
            title={LANGS[k].label} onClick={() => setLang(k)}>{LANGS[k].short}</button>
        ))}
      </div>

      {!app.status.aiEnabled && <div className="warn small">Voice needs the AI. <button className="link" onClick={() => app.setAiKeyOpen(true)}>Enter your API key</button></div>}
      {SR && (
        <label className="wake-row" title="While on, the browser's speech service (Google in Chrome, Microsoft in Edge) hears the microphone continuously to catch the word.">
          <input type="checkbox" checked={wakeOn} onChange={(e) => setWake(e.target.checked)} />
          <span>Start by saying <strong>“Kannaku”</strong>{wakeOn && <span className="muted"> · {wakeActive ? 'listening for it' : 'paused while busy'}</span>}</span>
          {wakeOn && <span className={`wake-dot ${wakeActive ? 'on' : ''}`} aria-hidden />}
        </label>
      )}
      {wakeErr && <div className="warn small">{wakeErr}</div>}
      {askConsent && (
        <div className="chat-card consent" role="dialog" aria-modal="false" aria-label="Microphone notice">
          <SpeechNotice wake={askConsent.wake} />
          <div className="chat-actions">
            <button className="primary" onClick={agree} autoFocus>{askConsent.wake ? 'I agree, turn on hands-free' : 'I agree, use the microphone'}</button>
            <button onClick={() => setAskConsent(null)}>Not now</button>
          </div>
        </div>
      )}
      {noTamilVoice && (
        <div className="warn small">This browser has no Tamil voice, so Tamil replies are shown but not spoken.{' '}
          <button className="link" onClick={() => setLang('tanglish')}>Switch to Tanglish</button> to hear them.</div>
      )}

      <div className="chat-log" ref={logRef} aria-live="polite">
        {log.length === 0 && (
          <div className="chat-empty">
            <p className="muted small">{lang === 'tanglish' ? 'Enna pannanum nu sollunga, illa idhula onna tap pannunga:' : lang === 'ta' ? 'என்ன செய்ய வேண்டும் என்று சொல்லுங்கள், அல்லது ஒன்றைத் தட்டுங்கள்:' : 'Say what you need, or tap one of these:'}</p>
            {L.examples.map((x) => <button key={x} className="chip" onClick={() => byHand(x)} disabled={busy}>{x}</button>)}
            <p className="muted small">What you say or type here is sent to Anthropic&rsquo;s Claude to understand it.</p>
          </div>
        )}
        {log.map((m) => (
          <div key={m.id} className={`bubble ${m.who} ${m.error ? 'error' : ''} ${speakingId === m.id ? 'speaking' : ''}`} lang={m.lang === 'ta' ? 'ta' : 'en'}>
            <span>{m.text}</span>
            {m.who === 'ai' && !m.error && (
              <button className="replay" onClick={() => (speakingId === m.id ? (window.speechSynthesis.cancel(), setSpeakingId(null)) : speak(m))}
                aria-label={speakingId === m.id ? 'Stop reading' : 'Read aloud'} title={speakingId === m.id ? 'Stop' : 'Read aloud'}>{speakingId === m.id ? '■' : '▶'}</button>
            )}
          </div>
        ))}
        {interim && <div className="bubble you interim">{interim}</div>}
        {busy && <div className="bubble ai typing" aria-label="Thinking"><i /><i /><i /></div>}

        {preview && pending?.kind === 'voucher' && (
          <div className="chat-card">
            <table className="mini"><tbody>{preview.entries.map((e, i) => {
              const v = BigInt(e.amountMinor);
              return <tr key={i}><td>{e.ledgerName}</td><td className="num">{v > 0n ? inr(v) : ''}</td><td className="num">{v < 0n ? inr(-v) : ''}</td></tr>;
            })}</tbody></table>
            {pending.draft.warnings.map((w) => <div key={w} className="warn small">{w}</div>)}
            <div className="chat-actions">
              <button className="primary" onClick={() => void confirm('screen')}>{L.yes} <Kbd>Ctrl+A</Kbd></button>
              <button onClick={() => void cancel()}>{L.no}</button>
            </div>
          </div>
        )}
        {pending?.kind === 'reverse' && (
          <div className="chat-actions">
            <button className="danger" onClick={() => void confirm('screen')}>Reverse No. {pending.target.voucherNo} <Kbd>Ctrl+A</Kbd></button>
            <button onClick={() => void cancel()}>{L.no}</button>
          </div>
        )}
      </div>

      <form className="chat-compose" onSubmit={(e) => { e.preventDefault(); if (typed.trim()) { byHand(typed.trim()); setTyped(''); } }}>
        <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={L.typeHint} aria-label="Type a message" disabled={listening} />
        {typed.trim()
          ? <button type="submit" className="send" aria-label="Send">➤</button>
          : SR && (
            <button type="button" className={`mic ${listening ? 'on' : ''}`} aria-pressed={listening}
              aria-label={listening ? 'Stop listening' : 'Start talking'} title={listening ? 'Tap to stop' : 'Tap to talk'}
              onClick={() => (listening ? stopListening() : withMic(() => startListening()))}>🎙</button>
          )}
      </form>
    </aside>
  );
}
