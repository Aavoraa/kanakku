import Decimal from 'decimal.js';
import { cellText, decToMinor, headerKey, parseAmount, parseDate, type Cell } from '../../lib/parse';
import { formatINR } from '../../lib/money';
import type { Sheet } from './files';

export interface StatementLine {
  lineNo: number;
  date: string;
  narration: string;
  ref: string | null;
  debitMinor: bigint;        // money out of the account
  creditMinor: bigint;       // money into the account
  balanceMinor: bigint | null;
}

export interface Issue { lineNo: number | null; code: string; severity: 'error' | 'warning' | 'info'; message: string }

export interface Statement {
  bankName: string | null;
  accountHint: string | null;   // last digits of the account number, if printed
  periodFrom: string | null;
  periodTo: string | null;
  openingMinor: bigint | null;
  closingMinor: bigint | null;
  lines: StatementLine[];
  issues: Issue[];
}

interface Cols { date: number; narration: number; ref: number; debit: number; credit: number; amount: number; drcr: number; balance: number }

const PATTERNS: [keyof Cols, RegExp][] = [
  ['date', /^(txn |tran |transaction |posting |value )?date$|^date of (transaction|txn)$|^dt$/],
  ['narration', /narration|description|particulars|remarks|details|transaction details|^desc/],
  ['ref', /chq|cheque|ref|utr|instrument/],
  ['debit', /^(withdrawal|withdrawals|debit|debits|dr|paid out|money out)( amt| amount)?( inr| rs)?$|withdrawal amount|debit amount/],
  ['credit', /^(deposit|deposits|credit|credits|cr|paid in|money in)( amt| amount)?( inr| rs)?$|deposit amount|credit amount/],
  ['amount', /^(amount|txn amount|transaction amount)( inr| rs)?$/],
  ['drcr', /^(dr ?\/ ?cr|cr ?\/ ?dr|type|txn type|dr cr|debit credit)$/],
  ['balance', /balance/],
];

/** Finds the header row: a date column plus either debit+credit columns or amount (+ Dr/Cr) columns. */
export function findStatementHeader(rows: Cell[][]): { row: number; cols: Cols } | null {
  let best: { row: number; cols: Cols; score: number } | null = null;
  for (let r = 0; r < Math.min(rows.length, 40); r++) {
    const cols: Cols = { date: -1, narration: -1, ref: -1, debit: -1, credit: -1, amount: -1, drcr: -1, balance: -1 };
    let dateIsValueDate = false;
    rows[r].forEach((c, i) => {
      const h = headerKey(c);
      if (!h) return;
      for (const [k, re] of PATTERNS) {
        if (!re.test(h)) continue;
        if (k === 'date') {
          // A transaction/posting date beats a value date, whichever column comes first.
          const isValue = /^value/.test(h);
          if (cols.date === -1 || (dateIsValueDate && !isValue)) { cols.date = i; dateIsValueDate = isValue; }
        } else if (cols[k] === -1) cols[k] = i;
        break;
      }
    });
    const money = (cols.debit >= 0 && cols.credit >= 0) || cols.amount >= 0;
    if (cols.date < 0 || !money) continue;
    const score = Object.values(cols).filter((v) => v >= 0).length;
    if (!best || score > best.score) best = { row: r, cols, score };
  }
  return best ? { row: best.row, cols: best.cols } : null;
}

// Whole words of a Type / Dr-Cr column. A prefix test reads "Deposit" (starts with d) as money out.
const OUT_WORDS = new Set(['d', 'dr', 'db', 'debit', 'debits', 'withdrawal', 'withdrawals', 'withdraw', 'wdl', 'wd', 'w']);
const IN_WORDS = new Set(['c', 'cr', 'credit', 'credits', 'deposit', 'deposits', 'dep', 'dpst']);

/** true for money out, false for money in, null when the column says neither (the amount's sign decides). */
function drcrWord(t: string): boolean | null {
  const w = t.toLowerCase().match(/[a-z]+/)?.[0] ?? '';
  return OUT_WORDS.has(w) ? true : IN_WORDS.has(w) ? false : null;
}

const minor = (c: Cell): bigint => { const d = parseAmount(c); return d ? decToMinor(d.abs()) : 0n; };

export function parseStatementSheet(sheet: Sheet): Statement | null {
  const header = findStatementHeader(sheet.rows);
  if (!header) return null;
  const { row: h, cols } = header;
  const lines: StatementLine[] = [];
  const issues: Issue[] = [];

  for (let r = h + 1; r < sheet.rows.length; r++) {
    const row = sheet.rows[r];
    const date = parseDate(row[cols.date] ?? null);
    if (!date) {
      // A wrapped narration continues on the next row with no date: append it.
      const extra = cols.narration >= 0 ? cellText(row[cols.narration] ?? null) : '';
      const rest = row.filter((c, i) => i !== cols.narration && cellText(c) !== '').length;
      if (extra && rest === 0 && lines.length) lines[lines.length - 1].narration += ` ${extra}`;
      continue;
    }
    let debit = 0n, credit = 0n;
    if (cols.debit >= 0 && cols.credit >= 0) {
      debit = minor(row[cols.debit] ?? null);
      credit = minor(row[cols.credit] ?? null);
    } else {
      const amt = parseAmount(row[cols.amount] ?? null) ?? new Decimal(0);
      const t = cols.drcr >= 0 ? cellText(row[cols.drcr] ?? null).toLowerCase() : '';
      const out = drcrWord(t) ?? amt.isNegative();
      const m = decToMinor(amt.abs());
      if (out) debit = m; else credit = m;
    }
    if (debit === 0n && credit === 0n) continue;           // opening-balance or blank rows
    const bal = cols.balance >= 0 ? parseAmount(row[cols.balance] ?? null) : null;
    lines.push({
      lineNo: lines.length + 1,
      date,
      narration: (cols.narration >= 0 ? cellText(row[cols.narration] ?? null) : '') || '(no narration)',
      ref: cols.ref >= 0 ? cellText(row[cols.ref] ?? null) || null : null,
      debitMinor: debit,
      creditMinor: credit,
      balanceMinor: bal ? decToMinor(bal) : null,
    });
  }
  if (!lines.length) return null;

  // Bank name and account digits from the rows above the header.
  const top = sheet.rows.slice(0, h).flat().map(cellText).filter(Boolean);
  const bankName = top.find((t) => /\bbank\b/i.test(t) && t.length < 60) ?? null;
  const acct = top.join(' ').match(/(?:a\/?c|account)[^0-9]{0,20}([0-9xX*]{6,20})/i);

  const st: Statement = {
    bankName, accountHint: acct ? acct[1].replace(/[^0-9]/g, '').slice(-4) || null : null,
    periodFrom: lines[0].date, periodTo: lines[lines.length - 1].date,
    openingMinor: null, closingMinor: null, lines, issues,
  };
  checkStatement(st);
  return st;
}

/**
 * Running-balance check: previous balance + credit - debit must equal the printed balance.
 * A break usually means a misread amount (OCR) or a missing row.
 */
export function checkStatement(st: Statement) {
  const first = st.lines[0];
  if (st.openingMinor === null && first?.balanceMinor !== null && first) {
    st.openingMinor = first.balanceMinor - first.creditMinor + first.debitMinor;
  }
  let running = st.openingMinor;
  for (const l of st.lines) {
    if (running !== null) running = running + l.creditMinor - l.debitMinor;
    if (l.balanceMinor !== null && running !== null && l.balanceMinor !== running) {
      st.issues.push({ lineNo: l.lineNo, code: 'BALANCE_BREAK', severity: 'warning', message: `Balance after this line should be ${fmt(running)} but the statement shows ${fmt(l.balanceMinor)}. An amount may be misread or a row missing.` });
      running = l.balanceMinor;
    }
  }
  const last = st.lines[st.lines.length - 1];
  if (st.closingMinor === null) st.closingMinor = last?.balanceMinor ?? running;
  if (st.openingMinor !== null && st.closingMinor !== null) {
    const credits = st.lines.reduce((s, l) => s + l.creditMinor, 0n);
    const debits = st.lines.reduce((s, l) => s + l.debitMinor, 0n);
    if (st.openingMinor + credits - debits !== st.closingMinor) {
      st.issues.push({ lineNo: null, code: 'TOTALS_MISMATCH', severity: 'error', message: `Opening ${fmt(st.openingMinor)} + deposits ${fmt(credits)} - withdrawals ${fmt(debits)} does not equal closing ${fmt(st.closingMinor)}.` });
    }
  }
}

const fmt = (m: bigint) => `₹${formatINR(m)}`;
