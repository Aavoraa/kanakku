/** Paise (string | bigint) -> "1,23,456.78" with Indian grouping. */
export function inr(minor: string | bigint | null | undefined, opts: { blankZero?: boolean; abs?: boolean } = {}): string {
  if (minor === null || minor === undefined || minor === '') return '';
  let v = typeof minor === 'bigint' ? minor : BigInt(minor);
  if (opts.blankZero && v === 0n) return '';
  if (opts.abs && v < 0n) v = -v;
  const neg = v < 0n;
  const a = neg ? -v : v;
  const int = (a / 100n).toString();
  const frac = (a % 100n).toString().padStart(2, '0');
  const last3 = int.slice(-3);
  const rest = int.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${rest ? `${rest},` : ''}${last3}.${frac}`;
}

/** Balance with Dr/Cr suffix, Tally style. */
export function drcr(minor: string | bigint | null | undefined): string {
  if (minor === null || minor === undefined) return '';
  const v = typeof minor === 'bigint' ? minor : BigInt(minor);
  if (v === 0n) return '0.00';
  return `${inr(v, { abs: true })} ${v > 0n ? 'Dr' : 'Cr'}`;
}

/** "5500.5" (rupees) -> 550050n paise; returns null if not a number. */
export function toMinor(rupees: string): bigint | null {
  const s = rupees.replace(/,/g, '').trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const [i, f = ''] = s.replace('-', '').split('.');
  const paise = BigInt(i) * 100n + BigInt((f + '00').slice(0, 2)) + (Number(f[2] ?? 0) >= 5 ? 1n : 0n);
  return s.startsWith('-') ? -paise : paise;
}

export function fromMinor(minor: bigint): string {
  const neg = minor < 0n;
  const a = neg ? -minor : minor;
  return `${neg ? '-' : ''}${a / 100n}.${(a % 100n).toString().padStart(2, '0')}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${Number(d)}-${MONTHS[Number(m) - 1]}-${y.slice(2)}`;
}

/** Today's date in India (the books' calendar), whatever the computer's time zone. */
export const todayIST = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);

function parseDec(s: string): { n: bigint; scale: number } | null {
  const t = s.replace(/,/g, '').trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const [i, f = ''] = t.split('.');
  return { n: BigInt(i + f), scale: f.length };
}

/** qty x rate in rupees, exact and rounded half-up to the paisa ("1" x "1.005" = "1.01"); null if either is not a number. */
export function multiplyAmount(qty: string, rate: string): string | null {
  const a = parseDec(qty);
  const b = parseDec(rate);
  if (!a || !b) return null;
  const div = 10n ** BigInt(a.scale + b.scale);
  return fromMinor((a.n * b.n * 200n + div) / (2n * div));
}

export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function fyStart(iso: string, fyStartMonth = 4): string {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const start = m >= fyStartMonth ? y : y - 1;
  return `${start}-${String(fyStartMonth).padStart(2, '0')}-01`;
}

export const TYPE_LABEL: Record<string, string> = {
  SALES: 'Sales', PURCHASE: 'Purchase', PAYMENT: 'Payment', RECEIPT: 'Receipt', JOURNAL: 'Journal',
  CONTRA: 'Contra', CREDIT_NOTE: 'Credit Note', DEBIT_NOTE: 'Debit Note', OPENING: 'Opening',
};

export const pct = (ppm: number | null | undefined) => (ppm === null || ppm === undefined ? '' : `${ppm / 10_000}%`);

export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
