/** Dates are ISO strings 'YYYY-MM-DD' in the company's local calendar (IST). */

export function todayIST(): string {
  const now = new Date(Date.now() + 5.5 * 3600 * 1000);
  return now.toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);
}

/** FY label year: FY 2026-27 -> 2027 (for fy_start_month = 4). */
export function fiscalYear(iso: string, fyStartMonth = 4): number {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  return m >= fyStartMonth ? y + 1 : y;
}

export function fyStart(iso: string, fyStartMonth = 4): string {
  const fy = fiscalYear(iso, fyStartMonth);
  const startYear = fyStartMonth === 1 ? fy : fy - 1;
  return `${startYear}-${String(fyStartMonth).padStart(2, '0')}-01`;
}

export function fyEnd(iso: string, fyStartMonth = 4): string {
  const start = fyStart(iso, fyStartMonth);
  const d = new Date(`${start}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export function monthStart(iso: string) { return `${iso.slice(0, 7)}-01`; }
export function monthEnd(iso: string) {
  const d = new Date(`${monthStart(iso)}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}
export function shiftMonths(iso: string, n: number) {
  const d = new Date(`${monthStart(iso)}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
}
function quarterStart(iso: string, fyStartMonth: number) {
  const m = Number(iso.slice(5, 7));
  const offset = (m - fyStartMonth + 12) % 12;
  return shiftMonths(iso, -(offset % 3));
}

export type PeriodName =
  | 'TODAY' | 'YESTERDAY' | 'THIS_WEEK' | 'THIS_MONTH' | 'LAST_MONTH'
  | 'THIS_QUARTER' | 'LAST_QUARTER' | 'THIS_FY' | 'LAST_FY' | 'AS_OF_TODAY' | 'UNSPECIFIED';

/** Resolves a spoken period to concrete dates against the company's fiscal year. */
export function resolvePeriod(p: PeriodName, today: string, fyStartMonth = 4): { from: string; to: string; label: string } {
  switch (p) {
    case 'TODAY': return { from: today, to: today, label: 'today' };
    case 'YESTERDAY': { const y = addDays(today, -1); return { from: y, to: y, label: 'yesterday' }; }
    case 'THIS_WEEK': {
      const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
      return { from: addDays(today, -dow), to: today, label: 'this week' };
    }
    case 'THIS_MONTH': return { from: monthStart(today), to: today, label: 'this month' };
    case 'LAST_MONTH': { const s = shiftMonths(today, -1); return { from: s, to: monthEnd(s), label: 'last month' }; }
    case 'THIS_QUARTER': return { from: quarterStart(today, fyStartMonth), to: today, label: 'this quarter' };
    case 'LAST_QUARTER': {
      const s = shiftMonths(quarterStart(today, fyStartMonth), -3);
      return { from: s, to: monthEnd(shiftMonths(s, 2)), label: 'last quarter' };
    }
    case 'THIS_FY': return { from: fyStart(today, fyStartMonth), to: today, label: 'this financial year' };
    case 'LAST_FY': {
      const prevEnd = addDays(fyStart(today, fyStartMonth), -1);
      return { from: fyStart(prevEnd, fyStartMonth), to: prevEnd, label: 'last financial year' };
    }
    default: return { from: fyStart(today, fyStartMonth), to: today, label: 'to date' };
  }
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** "18 Sep 2026", for messages people read. */
export function shortDate(iso: string): string {
  return `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1].slice(0, 3)} ${iso.slice(0, 4)}`;
}

export function speakDate(iso: string): string {
  return `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;
}
