import Decimal from 'decimal.js';

/** Half-up integer division for non-negative or negative numerators (symmetric). */
export function divRound(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new Error('divRound: divisor must be positive');
  const neg = n < 0n;
  const a = neg ? -n : n;
  const q = a / d;
  const r = (a % d) * 2n >= d ? q + 1n : q;
  return neg ? -r : r;
}

export const DEC_RE = /^-?\d+(\.\d+)?$/;

/** Rupees typed by a person ("1,234.50", 500) -> paise, or null when it is not a plain non-negative amount. */
export function parseRupees(v: unknown): bigint | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).replace(/,/g, '').trim();
  return /^\d+(\.\d+)?$/.test(s) ? toMinor(s) : null;
}

/** "1234.5" (rupees) -> 123450n (paise). Rounds half-up beyond 2 decimals. */
export function toMinor(rupees: string | number | Decimal): bigint {
  const d = new Decimal(rupees as Decimal.Value);
  return BigInt(d.times(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0));
}

/** 123450n -> "1234.50" */
export function fromMinor(minor: bigint): string {
  const neg = minor < 0n;
  const a = neg ? -minor : minor;
  const s = `${a / 100n}.${(a % 100n).toString().padStart(2, '0')}`;
  return neg ? `-${s}` : s;
}

/** Percent string ("18", "0.25") -> parts per million (180000, 2500). */
export function percentToPpm(pct: string | number | null | undefined): number {
  if (pct === null || pct === undefined || pct === '') return 0;
  return new Decimal(pct as Decimal.Value).times(10_000).toDecimalPlaces(0).toNumber();
}

export function ppmToPercent(ppm: number): string {
  return new Decimal(ppm).div(10_000).toString();
}

/** Indian digit grouping: 12345678.5 -> "1,23,45,678.50" */
export function formatINR(minor: bigint): string {
  const s = fromMinor(minor);
  const neg = s.startsWith('-');
  const [int, frac] = (neg ? s.slice(1) : s).split('.');
  const last3 = int.slice(-3);
  const rest = int.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${rest ? rest + ',' : ''}${last3}.${frac}`;
}

const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function below1000(n: number): string {
  const parts: string[] = [];
  if (n >= 100) { parts.push(`${ONES[Math.floor(n / 100)]} hundred`); n %= 100; }
  if (n >= 20) { parts.push(TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : '')); }
  else if (n > 0) parts.push(ONES[n]);
  return parts.join(' ');
}

/** 550000n -> "five thousand five hundred rupees"; uses lakh / crore. */
export function amountInWords(minor: bigint): string {
  const neg = minor < 0n;
  const a = neg ? -minor : minor;
  let rupees = Number(a / 100n);
  const paise = Number(a % 100n);
  const parts: string[] = [];
  const crore = Math.floor(rupees / 1e7); rupees %= 1e7;
  const lakh = Math.floor(rupees / 1e5); rupees %= 1e5;
  const thousand = Math.floor(rupees / 1e3); rupees %= 1e3;
  if (crore) parts.push(`${amountInWords(BigInt(crore) * 100n).replace(/ rupees?$/, '')} crore`);
  if (lakh) parts.push(`${below1000(lakh)} lakh`);
  if (thousand) parts.push(`${below1000(thousand)} thousand`);
  if (rupees) parts.push(below1000(rupees));
  let out = parts.length ? `${parts.join(' ')} rupees` : 'zero rupees';
  if (paise) out += ` and ${below1000(paise)} paise`;
  return (neg ? 'minus ' : '') + out;
}
