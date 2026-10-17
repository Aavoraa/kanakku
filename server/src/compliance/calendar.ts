import { addDays, monthEnd, monthStart, shiftMonths } from '../lib/dates';

/**
 * Statutory due dates for Indian GST, TDS and income tax, and the company's own repeating reminders.
 *
 * These are the standard dates in the law. The government often extends them by notification, so every
 * date can be overridden per company (compliance_records.due_date), and the screen says to check the portals.
 * The statutory year is always April to March, whatever the company's books use.
 */
export type Kind = 'GSTR1' | 'GSTR3B' | 'PMT06' | 'GSTR9' | 'TDS_PAY' | 'TDS_RETURN' | 'ADV_TAX' | 'ITR' | 'TAX_AUDIT' | 'TASK' | 'ASSET' | 'PETTY_LOW';
export type Category = 'GST' | 'TDS' | 'INCOME_TAX' | 'TASK' | 'ASSET' | 'CASH';

export interface ComplianceSettings {
  /** GST returns (only when the company has a GSTIN). */
  gst: boolean;
  /** MONTHLY, or QUARTERLY under the QRMP scheme (PMT-06 payments in months 1 and 2). */
  gstFrequency: 'MONTHLY' | 'QUARTERLY';
  /** GSTR-9 annual return. */
  gstAnnual: boolean;
  incomeTax: boolean;
  /** Accounts audited under s.44AB: later ITR date, plus the tax audit report. */
  taxAudit: boolean;
  advanceTax: boolean;
  /** TDS deducted: monthly payment and quarterly returns. */
  tds: boolean;
  /** Days before a due date that a reminder starts showing. */
  remindDays: number;
}

export const DEFAULT_SETTINGS: ComplianceSettings = {
  gst: true, gstFrequency: 'MONTHLY', gstAnnual: false, incomeTax: true, taxAudit: false, advanceTax: true, tds: false, remindDays: 5,
};

export function parseSettings(raw: unknown): ComplianceSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const bool = (k: keyof ComplianceSettings) => (typeof r[k] === 'boolean' ? r[k] as boolean : DEFAULT_SETTINGS[k] as boolean);
  const days = Number(r.remindDays);
  return {
    gst: bool('gst'),
    gstFrequency: r.gstFrequency === 'QUARTERLY' ? 'QUARTERLY' : 'MONTHLY',
    gstAnnual: bool('gstAnnual'),
    incomeTax: bool('incomeTax'),
    taxAudit: bool('taxAudit'),
    advanceTax: bool('advanceTax'),
    tds: bool('tds'),
    remindDays: Number.isInteger(days) && days >= 0 && days <= 30 ? days : DEFAULT_SETTINGS.remindDays,
  };
}

export interface Due {
  key: string;
  kind: Kind;
  category: Category;
  title: string;
  periodLabel: string;
  periodFrom: string;
  periodTo: string;
  /** The statutory (or task) date, before any override. */
  dueDate: string;
  remindDays: number;
  taskId?: string;
  taskCategory?: string;
  notes?: string | null;
  /** Screen to open from the bell instead of the calendar (petty cash, asset register). */
  link?: string;
}

/**
 * QRMP GSTR-3B is due on the 22nd for these states and union territories (Category X), the 24th elsewhere.
 * Chhattisgarh, MP, Gujarat, Daman & Diu, DNH, Maharashtra, Karnataka, Goa, Lakshadweep, Kerala, Tamil Nadu,
 * Puducherry, Andaman & Nicobar, Telangana, Andhra Pradesh.
 */
const QRMP_22ND = new Set(['22', '23', '24', '25', '26', '27', '29', '30', '31', '32', '33', '34', '35', '36', '37']);

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const month = (iso: string) => Number(iso.slice(5, 7));
const year = (iso: string) => Number(iso.slice(0, 4));
const ymd = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
/** The given day of the month after `iso`'s month. */
const nextMonthDay = (iso: string, day: number) => { const n = shiftMonths(iso, 1); return ymd(year(n), month(n), day); };
const monthLabel = (iso: string) => `${MON[month(iso) - 1]} ${year(iso)}`;
const rangeLabel = (from: string, to: string) => `${MON[month(from) - 1]}–${MON[month(to) - 1]} ${year(to)}`;
/** FY 2025-26 for a date between April 2025 and March 2026. */
const fyOf = (iso: string) => { const s = month(iso) >= 4 ? year(iso) : year(iso) - 1; return { from: ymd(s, 4, 1), to: ymd(s + 1, 3, 31), label: `FY ${s}-${String(s + 1).slice(2)}`, endYear: s + 1 }; };

export interface CompanyFacts { stateCode: string; hasGstin: boolean; booksFrom: string }

/** Statutory obligations whose due date falls between `from` and `to` (inclusive). */
export function statutoryDues(s: ComplianceSettings, co: CompanyFacts, from: string, to: string): Due[] {
  const out: Due[] = [];
  const add = (d: Omit<Due, 'key' | 'remindDays'>) => {
    if (d.dueDate < from || d.dueDate > to || d.periodTo < co.booksFrom) return;
    out.push({ ...d, key: `${d.kind}:${d.periodFrom.slice(0, 7)}:${d.periodTo.slice(0, 7)}`, remindDays: s.remindDays });
  };
  const gst = s.gst && co.hasGstin;

  // Walk the return periods (months) whose filings can fall due in the window; the longest lag is 9 months (GSTR-9).
  for (let m = monthStart(shiftMonths(from, -10)); m <= to; m = shiftMonths(m, 1)) {
    const end = monthEnd(m);
    const mm = month(m);
    const posInQuarter = (mm - 1) % 3;              // Indian quarters are Apr-Jun, Jul-Sep, Oct-Dec, Jan-Mar
    const qFrom = shiftMonths(m, -posInQuarter);
    const fy = fyOf(m);

    if (gst && s.gstFrequency === 'MONTHLY') {
      add({ kind: 'GSTR1', category: 'GST', title: 'GSTR-1 (outward supplies)', periodLabel: monthLabel(m), periodFrom: m, periodTo: end, dueDate: nextMonthDay(m, 11) });
      add({ kind: 'GSTR3B', category: 'GST', title: 'GSTR-3B return and GST payment', periodLabel: monthLabel(m), periodFrom: m, periodTo: end, dueDate: nextMonthDay(m, 20) });
    }
    if (gst && s.gstFrequency === 'QUARTERLY') {
      if (posInQuarter < 2) {
        add({ kind: 'PMT06', category: 'GST', title: 'PMT-06 GST payment (QRMP)', periodLabel: monthLabel(m), periodFrom: m, periodTo: end, dueDate: nextMonthDay(m, 25) });
      } else {
        add({ kind: 'GSTR1', category: 'GST', title: 'GSTR-1 (outward supplies, quarterly)', periodLabel: rangeLabel(qFrom, m), periodFrom: qFrom, periodTo: end, dueDate: nextMonthDay(m, 13) });
        add({ kind: 'GSTR3B', category: 'GST', title: 'GSTR-3B return and GST payment (quarterly)', periodLabel: rangeLabel(qFrom, m), periodFrom: qFrom, periodTo: end,
          dueDate: nextMonthDay(m, QRMP_22ND.has(co.stateCode) ? 22 : 24) });
      }
    }
    if (gst && s.gstAnnual && mm === 3) {
      add({ kind: 'GSTR9', category: 'GST', title: 'GSTR-9 annual return', periodLabel: fy.label, periodFrom: fy.from, periodTo: fy.to, dueDate: ymd(fy.endYear, 12, 31) });
    }

    if (s.tds) {
      // March's TDS is due on 30 April; every other month's on the 7th of the next month.
      add({ kind: 'TDS_PAY', category: 'TDS', title: 'TDS / TCS payment', periodLabel: monthLabel(m), periodFrom: m, periodTo: end, dueDate: mm === 3 ? nextMonthDay(m, 30) : nextMonthDay(m, 7) });
      if (posInQuarter === 2) {
        const due = mm === 3 ? ymd(year(m), 5, 31) : mm === 12 ? ymd(year(m) + 1, 1, 31) : monthEnd(shiftMonths(m, 1));
        add({ kind: 'TDS_RETURN', category: 'TDS', title: 'TDS / TCS quarterly return (24Q / 26Q / 27EQ)', periodLabel: rangeLabel(qFrom, m), periodFrom: qFrom, periodTo: end, dueDate: due });
      }
    }

    if (s.incomeTax && s.advanceTax && [6, 9, 12, 3].includes(mm)) {
      const share = { 6: '15%', 9: '45%', 12: '75%', 3: '100%' }[mm as 6 | 9 | 12 | 3];
      add({ kind: 'ADV_TAX', category: 'INCOME_TAX', title: `Advance tax instalment (${share} of the year's tax)`, periodLabel: fy.label, periodFrom: fy.from, periodTo: end, dueDate: ymd(year(m), mm, 15) });
    }
    if (s.incomeTax && mm === 3) {
      if (s.taxAudit) {
        add({ kind: 'TAX_AUDIT', category: 'INCOME_TAX', title: 'Tax audit report (Form 3CA/3CB with 3CD)', periodLabel: fy.label, periodFrom: fy.from, periodTo: fy.to, dueDate: ymd(fy.endYear, 9, 30) });
      }
      add({ kind: 'ITR', category: 'INCOME_TAX', title: 'Income-tax return', periodLabel: fy.label, periodFrom: fy.from, periodTo: fy.to,
        dueDate: s.taxAudit ? ymd(fy.endYear, 10, 31) : ymd(fy.endYear, 7, 31) });
    }
  }
  return out.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.key.localeCompare(b.key));
}

export type Repeat = 'NONE' | 'MONTHLY' | 'QUARTERLY' | 'HALF_YEARLY' | 'YEARLY';
export interface TaskRow { id: string; title: string; category: string; first_due: string; repeat: Repeat; remind_days: number; notes: string | null }

/** `iso` moved by n months, keeping the day where the month has it (31 Jan + 1 = 28/29 Feb). */
export function addMonthsKeepDay(iso: string, n: number): string {
  const target = shiftMonths(iso, n);
  const last = Number(monthEnd(target).slice(8, 10));
  return ymd(year(target), month(target), Math.min(Number(iso.slice(8, 10)), last));
}

const STEP: Record<Repeat, number> = { NONE: 0, MONTHLY: 1, QUARTERLY: 3, HALF_YEARLY: 6, YEARLY: 12 };
const EVERY: Record<Repeat, string> = { NONE: 'One-off', MONTHLY: 'monthly', QUARTERLY: 'quarterly', HALF_YEARLY: 'half-yearly', YEARLY: 'yearly' };

/**
 * Each occurrence of repeating reminders between `from` and `to`: the company's own tasks, and (with
 * kind ASSET) asset service, AMC and insurance dates.
 */
export function taskDues(tasks: TaskRow[], from: string, to: string, as: { kind: 'TASK' | 'ASSET'; link?: string } = { kind: 'TASK' }): Due[] {
  const out: Due[] = [];
  for (const t of tasks) {
    const step = STEP[t.repeat];
    for (let i = 0; ; i++) {
      const due = step ? addMonthsKeepDay(t.first_due, i * step) : t.first_due;
      if (due > to) break;
      if (due >= from) {
        out.push({
          key: `${as.kind}:${t.id}:${due}`, kind: as.kind, category: as.kind, title: t.title, periodLabel: EVERY[t.repeat],
          periodFrom: due, periodTo: due, dueDate: due, remindDays: t.remind_days, taskId: t.id, taskCategory: t.category, notes: t.notes,
          ...(as.link ? { link: as.link } : {}),
        });
      }
      if (!step) break;
    }
  }
  return out;
}

/** The first day a reminder for `due` shows. */
export const remindFrom = (due: string, days: number) => addDays(due, -days);
