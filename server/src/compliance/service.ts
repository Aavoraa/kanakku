import { many, maybeOne, one, type Db, type Database } from '../db/client';
import { invalid, notFound } from '../lib/errors';
import { addDays, daysBetween, todayIST } from '../lib/dates';
import { toMinor } from '../lib/money';
import { audit } from '../ledger/post';
import { gstSummary } from '../reports/gst';
import { formatINR } from '../lib/money';
import { assetScheduleRows } from '../assets/service';
import { lowPettyCash } from '../pettycash/service';
import { parseSettings, remindFrom, statutoryDues, taskDues, type ComplianceSettings, type Due, type Repeat, type TaskRow } from './calendar';

export type Status = 'DONE' | 'OVERDUE' | 'DUE_SOON' | 'UPCOMING';

export interface Item extends Due {
  /** Due date in force: the extended date when one was entered, else the statutory one. */
  due: string;
  extended: boolean;
  status: Status;
  daysLeft: number;
  /** Cash GST payable for the period from the books (GSTR-3B / PMT-06), net of PMT-06 already paid for a quarter. */
  estimateMinor: bigint | null;
  record: { doneOn: string | null; reference: string | null; amountMinor: bigint | null; notes: string | null } | null;
}

interface RecordRow { key: string; done_on: string | null; reference: string | null; amount_minor: bigint | null; notes: string | null; due_date: string | null }
interface CompanyRow { state_code: string; gstin: string | null; books_from: string; compliance: unknown }

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const KEY_RE = /^(GSTR1|GSTR3B|PMT06|GSTR9|TDS_PAY|TDS_RETURN|ADV_TAX|ITR|TAX_AUDIT|TASK|ASSET):[A-Za-z0-9:-]{5,80}$/;

async function company(db: Db, companyId: string) {
  const c = await one<CompanyRow>(db, `SELECT state_code, gstin, books_from::text, compliance FROM companies WHERE id = $1`, [companyId]);
  return { settings: parseSettings(c.compliance), facts: { stateCode: c.state_code, hasGstin: Boolean(c.gstin), booksFrom: c.books_from } };
}

async function activeTasks(db: Db, companyId: string) {
  return many<TaskRow>(db,
    `SELECT id, title, category, first_due::text, repeat, remind_days, notes FROM compliance_tasks WHERE company_id = $1 AND active ORDER BY first_due`, [companyId]);
}

/** Every obligation and reminder falling due between `from` and `to`, with its filing record and status. */
export async function complianceItems(db: Db, companyId: string, from: string, to: string, today = todayIST()): Promise<Item[]> {
  const { settings, facts } = await company(db, companyId);
  const dues = [
    ...statutoryDues(settings, facts, from, to),
    ...taskDues(await activeTasks(db, companyId), from, to),
    ...taskDues(await assetScheduleRows(db, companyId), from, to, { kind: 'ASSET', link: 'assets' }),
  ];
  if (!dues.length) return [];
  const records = new Map((await many<RecordRow>(db,
    `SELECT key, done_on::text, reference, amount_minor, notes, due_date::text FROM compliance_records WHERE company_id = $1 AND key = ANY($2::text[])`,
    [companyId, dues.map((d) => d.key)])).map((r) => [r.key, r]));

  const items: Item[] = [];
  for (const d of dues) {
    const r = records.get(d.key);
    const due = r?.due_date ?? d.dueDate;
    const status: Status = r?.done_on ? 'DONE' : due < today ? 'OVERDUE' : remindFrom(due, d.remindDays) <= today ? 'DUE_SOON' : 'UPCOMING';
    items.push({
      ...d, due, extended: Boolean(r?.due_date && r.due_date !== d.dueDate), status, daysLeft: daysBetween(today, due), estimateMinor: null,
      record: r ? { doneOn: r.done_on, reference: r.reference, amountMinor: r.amount_minor, notes: r.notes } : null,
    });
  }
  // What the books say is payable, for GST payments still to be made (the "calculation" behind the reminder).
  for (const it of items) {
    if (it.status === 'DONE' || (it.kind !== 'GSTR3B' && it.kind !== 'PMT06')) continue;
    const g = await gstSummary(db, companyId, it.periodFrom, it.periodTo);
    let payable = BigInt(g.netPayableMinor);
    if (it.kind === 'GSTR3B' && settings.gstFrequency === 'QUARTERLY') {
      const paid = items.filter((p) => p.kind === 'PMT06' && p.periodFrom >= it.periodFrom && p.periodTo <= it.periodTo)
        .reduce((s, p) => s + (p.record?.amountMinor ?? 0n), 0n);
      payable = payable > paid ? payable - paid : 0n;
    }
    it.estimateMinor = payable;
  }
  return items.sort((a, b) => a.due.localeCompare(b.due) || a.key.localeCompare(b.key));
}

/** What needs attention now: overdue, and due within each item's reminder window. Oldest first. */
export async function complianceAlerts(db: Db, companyId: string, today = todayIST()) {
  // Back far enough to keep nagging about anything left undone in the last year and a bit; ahead past the longest reminder window.
  const items = await complianceItems(db, companyId, addDays(today, -400), addDays(today, 91), today);
  const alerts = items.filter((i) => i.status === 'OVERDUE' || i.status === 'DUE_SOON');
  // Petty cash boxes below a quarter of their float need a top-up.
  for (const b of await lowPettyCash(db, companyId)) {
    alerts.push({
      key: `PETTY:${b.id}`, kind: 'PETTY_LOW', category: 'CASH', title: `Top up ${b.name}: ₹${formatINR(b.balanceMinor)} left of ₹${formatINR(b.floatMinor)}`,
      periodLabel: b.custodian ?? 'petty cash', periodFrom: today, periodTo: today, dueDate: today, due: today, remindDays: 0, extended: false,
      status: 'DUE_SOON', daysLeft: 0, estimateMinor: b.topUpMinor, record: null, link: 'petty-cash',
    });
  }
  return { today, overdue: alerts.filter((a) => a.status === 'OVERDUE').length, dueSoon: alerts.filter((a) => a.status === 'DUE_SOON').length, items: alerts };
}

export async function complianceSettings(db: Db, companyId: string): Promise<ComplianceSettings> {
  return (await company(db, companyId)).settings;
}

export async function updateComplianceSettings(db: Database, companyId: string, patch: unknown, userId: string) {
  if (!patch || typeof patch !== 'object') throw invalid('Compliance settings must be an object');
  const before = await complianceSettings(db, companyId);
  const after = parseSettings({ ...before, ...(patch as object) });
  await db.query(`UPDATE companies SET compliance = $2 WHERE id = $1`, [companyId, JSON.stringify(after)]);
  await audit(db, companyId, userId, 'MANUAL', 'UPDATE', 'compliance_settings', companyId, before, after);
  return after;
}

export interface RecordPatch { doneOn?: string | null; reference?: string | null; amount?: string | null; notes?: string | null; dueDate?: string | null }

/** Marks an occurrence filed or paid (with its ARN / challan and amount), extends its due date, or undoes either. */
export async function saveRecord(db: Database, companyId: string, key: string, p: RecordPatch, userId: string) {
  if (!KEY_RE.test(key)) throw invalid('Unknown compliance item');
  const date = (v: unknown, label: string) => {
    if (v === undefined) return undefined;
    if (v === null || v === '') return null;
    if (typeof v !== 'string' || !DATE_RE.test(v)) throw invalid(`${label} is not a valid date`);
    return v;
  };
  const text = (v: unknown, max: number) => (v === undefined ? undefined : v === null || v === '' ? null : String(v).trim().slice(0, max));
  const doneOn = date(p.doneOn, 'Date done');
  if (doneOn && doneOn > todayIST()) throw invalid('The date done cannot be in the future');
  const dueDate = date(p.dueDate, 'Due date');
  let amount: bigint | null | undefined;
  if (p.amount === undefined) amount = undefined;
  else if (p.amount === null || p.amount === '') amount = null;
  else {
    const s = String(p.amount).replace(/,/g, '').trim();
    if (!/^\d+(\.\d+)?$/.test(s)) throw invalid('Enter the amount paid in rupees, like 12500');
    amount = toMinor(s);
  }

  const before = await maybeOne<RecordRow>(db,
    `SELECT key, done_on::text, reference, amount_minor, notes, due_date::text FROM compliance_records WHERE company_id = $1 AND key = $2`, [companyId, key]);
  const reference = text(p.reference, 100);
  const notes = text(p.notes, 500);
  // Fields left out keep their value, so "extend the due date" and "mark filed" can be saved separately.
  const next = {
    done_on: doneOn === undefined ? before?.done_on ?? null : doneOn,
    reference: reference === undefined ? before?.reference ?? null : reference,
    amount_minor: amount === undefined ? before?.amount_minor ?? null : amount,
    notes: notes === undefined ? before?.notes ?? null : notes,
    due_date: dueDate === undefined ? before?.due_date ?? null : dueDate,
  };
  await db.transaction(async (tx) => {
    if (!next.done_on && !next.reference && next.amount_minor === null && !next.notes && !next.due_date) {
      await tx.query(`DELETE FROM compliance_records WHERE company_id = $1 AND key = $2`, [companyId, key]);
    } else {
      await tx.query(
        `INSERT INTO compliance_records (company_id, key, done_on, reference, amount_minor, notes, due_date, updated_by, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
         ON CONFLICT (company_id, key) DO UPDATE SET done_on = $3, reference = $4, amount_minor = $5, notes = $6, due_date = $7, updated_by = $8, updated_at = now()`,
        [companyId, key, next.done_on, next.reference, next.amount_minor, next.notes, next.due_date, userId]);
    }
    // Every change to a filing record is kept, like changes to the books.
    await audit(tx, companyId, userId, 'MANUAL', before ? 'UPDATE' : 'CREATE', 'compliance_record', key, before, { key, ...next });
  });
  return { key, ...next };
}

const CATEGORIES = new Set(['WORKING', 'CALCULATION', 'ADJUSTMENT', 'FILING', 'PAYMENT', 'OTHER']);
const REPEATS = new Set(['NONE', 'MONTHLY', 'QUARTERLY', 'YEARLY']);

export interface NewTask { title?: string; category?: string; firstDue?: string; repeat?: string; remindDays?: number | string; notes?: string | null }

export async function createTask(db: Database, companyId: string, t: NewTask, userId: string) {
  const title = (t.title ?? '').trim();
  if (!title) throw invalid('Enter what the reminder is for');
  const category = t.category ?? 'OTHER';
  if (!CATEGORIES.has(category)) throw invalid('Unknown reminder category');
  if (!t.firstDue || !DATE_RE.test(t.firstDue)) throw invalid('Enter the due date');
  const repeat = (t.repeat ?? 'NONE') as Repeat;
  if (!REPEATS.has(repeat)) throw invalid('Repeat must be none, monthly, quarterly or yearly');
  const remind = t.remindDays === undefined || t.remindDays === '' ? 3 : Number(t.remindDays);
  if (!Number.isInteger(remind) || remind < 0 || remind > 60) throw invalid('Remind between 0 and 60 days before');
  const row = await one<{ id: string }>(db,
    `INSERT INTO compliance_tasks (company_id, title, category, first_due, repeat, remind_days, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [companyId, title.slice(0, 200), category, t.firstDue, repeat, remind, t.notes?.trim().slice(0, 1000) || null, userId]);
  await audit(db, companyId, userId, 'MANUAL', 'CREATE', 'compliance_task', row.id, null, { title, category, firstDue: t.firstDue, repeat, remind });
  return row;
}

export async function listTasks(db: Db, companyId: string) {
  return many(db,
    `SELECT id, title, category, first_due::text AS "firstDue", repeat, remind_days AS "remindDays", notes FROM compliance_tasks
      WHERE company_id = $1 AND active ORDER BY first_due, title`, [companyId]);
}

/** Stops a reminder. Its past records stay (kept for the audit trail). */
export async function deleteTask(db: Database, companyId: string, taskId: string, userId: string) {
  const t = await maybeOne<{ title: string }>(db, `SELECT title FROM compliance_tasks WHERE id = $1 AND company_id = $2 AND active`, [taskId, companyId]);
  if (!t) throw notFound('Reminder');
  await db.query(`UPDATE compliance_tasks SET active = false WHERE id = $1`, [taskId]);
  await audit(db, companyId, userId, 'MANUAL', 'DELETE', 'compliance_task', taskId, { title: t.title }, null);
}
