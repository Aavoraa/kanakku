import { many, maybeOne, one, type Db, type Database } from '../db/client';
import { invalid, notFound } from '../lib/errors';
import { fromMinor, toMinor } from '../lib/money';
import { todayIST } from '../lib/dates';
import { LedgerContext } from '../ledger/context';
import { createLedger, groupByCode } from '../ledger/masters';
import { audit } from '../ledger/post';
import { postExpense } from '../ledger/expense';
import type { TaskRow } from '../compliance/calendar';
import { saveRecord } from '../compliance/service';

/**
 * Asset register and upkeep: what the business owns, when each needs servicing, AMC or insurance renewal (these
 * show in the compliance calendar and the bell), and a log of repairs and services, optionally posted as expenses.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const KINDS = new Set(['SERVICE', 'AMC', 'INSURANCE', 'WARRANTY', 'LICENCE', 'INSPECTION', 'OTHER']);
const LOG_KINDS = new Set(['REPAIR', 'SERVICE', 'AMC', 'INSURANCE', 'INSPECTION', 'OTHER']);
const REPEATS = new Set(['NONE', 'MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'YEARLY']);
const KIND_LABEL: Record<string, string> = {
  SERVICE: 'Service', AMC: 'AMC renewal', INSURANCE: 'Insurance renewal', WARRANTY: 'Warranty ends', LICENCE: 'Licence renewal', INSPECTION: 'Inspection', OTHER: 'Upkeep',
};

const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const optDate = (v: unknown, label: string) => {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !DATE_RE.test(v)) throw invalid(`${label} is not a valid date`);
  return v;
};
const optMoney = (v: unknown, label: string) => {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).replace(/,/g, '').trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw invalid(`Enter the ${label} in rupees`);
  return toMinor(s);
};

export interface AssetInput { name?: string; category?: string | null; ledgerId?: string | null; location?: string | null; serialNo?: string | null; purchaseDate?: string | null; cost?: string | null; notes?: string | null }

async function checkLedger(db: Db, companyId: string, ledgerId: string | null | undefined) {
  if (!ledgerId) return null;
  const l = await maybeOne<{ id: string }>(db, `SELECT id FROM ledgers WHERE id = $1 AND company_id = $2`, [ledgerId, companyId]);
  if (!l) throw invalid('That ledger does not exist');
  return ledgerId;
}

export async function createAsset(db: Database, companyId: string, a: AssetInput, userId: string) {
  const name = text(a.name, 200);
  if (!name) throw invalid('Enter the asset name');
  const row = await one<{ id: string }>(db,
    `INSERT INTO assets (company_id, name, category, ledger_id, location, serial_no, purchase_date, cost_minor, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [companyId, name, text(a.category, 80), await checkLedger(db, companyId, a.ledgerId), text(a.location, 120), text(a.serialNo, 120),
      optDate(a.purchaseDate, 'Purchase date'), optMoney(a.cost, 'cost'), text(a.notes, 1000), userId]);
  await audit(db, companyId, userId, 'MANUAL', 'CREATE', 'asset', row.id, null, { ...a, name });
  return row;
}

export async function updateAsset(db: Database, companyId: string, assetId: string, a: AssetInput & { active?: boolean }, userId: string) {
  const before = await maybeOne<Record<string, unknown>>(db, `SELECT * FROM assets WHERE id = $1 AND company_id = $2`, [assetId, companyId]);
  if (!before) throw notFound('Asset');
  const name = a.name === undefined ? before.name as string : text(a.name, 200);
  if (!name) throw invalid('Enter the asset name');
  const pick = <T>(v: T | undefined, cur: unknown, f: (x: T) => unknown) => (v === undefined ? cur : f(v));
  const next = {
    name,
    category: pick(a.category, before.category, (v) => text(v, 80)),
    ledger_id: a.ledgerId === undefined ? before.ledger_id : await checkLedger(db, companyId, a.ledgerId),
    location: pick(a.location, before.location, (v) => text(v, 120)),
    serial_no: pick(a.serialNo, before.serial_no, (v) => text(v, 120)),
    purchase_date: pick(a.purchaseDate, before.purchase_date, (v) => optDate(v, 'Purchase date')),
    cost_minor: pick(a.cost, before.cost_minor, (v) => optMoney(v, 'cost')),
    notes: pick(a.notes, before.notes, (v) => text(v, 1000)),
    active: a.active === undefined ? before.active : Boolean(a.active),
  };
  await db.query(
    `UPDATE assets SET name = $2, category = $3, ledger_id = $4, location = $5, serial_no = $6, purchase_date = $7, cost_minor = $8, notes = $9, active = $10 WHERE id = $1`,
    [assetId, next.name, next.category, next.ledger_id, next.location, next.serial_no, next.purchase_date, next.cost_minor, next.notes, next.active]);
  // A retired asset's schedules stop reminding.
  if (next.active === false) await db.query(`UPDATE asset_schedules SET active = false WHERE asset_id = $1`, [assetId]);
  await audit(db, companyId, userId, 'MANUAL', 'UPDATE', 'asset', assetId, before, next);
}

export async function listAssets(db: Db, companyId: string, includeRetired = false) {
  return many(db,
    `SELECT a.id, a.name, a.category, a.ledger_id AS "ledgerId", l.name AS "ledgerName", a.location, a.serial_no AS "serialNo",
            a.purchase_date::text AS "purchaseDate", a.cost_minor AS "costMinor", a.notes, a.active,
            (SELECT MIN(next_due)::text FROM asset_schedules s WHERE s.asset_id = a.id AND s.active) AS "nextDue",
            COALESCE((SELECT SUM(cost_minor) FROM asset_logs g WHERE g.asset_id = a.id), 0)::bigint AS "upkeepMinor",
            (SELECT MAX(log_date)::text FROM asset_logs g WHERE g.asset_id = a.id) AS "lastUpkeep"
       FROM assets a LEFT JOIN ledgers l ON l.id = a.ledger_id
      WHERE a.company_id = $1 AND ($2 OR a.active) ORDER BY a.active DESC, a.name`, [companyId, includeRetired]);
}

export async function assetDetail(db: Db, companyId: string, assetId: string) {
  const asset = (await listAssets(db, companyId, true)).find((a) => (a as { id: string }).id === assetId);
  if (!asset) throw notFound('Asset');
  const schedules = await many(db,
    `SELECT id, kind, title, next_due::text AS "nextDue", repeat, remind_days AS "remindDays", vendor, notes
       FROM asset_schedules WHERE asset_id = $1 AND active ORDER BY next_due`, [assetId]);
  const logs = await many(db,
    `SELECT g.id, g.log_date::text AS date, g.kind, g.description, g.cost_minor AS "costMinor", g.vendor, v.voucher_no AS "voucherNo", g.voucher_id AS "voucherId"
       FROM asset_logs g LEFT JOIN vouchers v ON v.id = g.voucher_id WHERE g.asset_id = $1 ORDER BY g.log_date DESC, g.created_at DESC`, [assetId]);
  return { asset, schedules, logs };
}

async function asset(db: Db, companyId: string, assetId: string) {
  const a = await maybeOne<{ id: string; name: string; active: boolean }>(db, `SELECT id, name, active FROM assets WHERE id = $1 AND company_id = $2`, [assetId, companyId]);
  if (!a) throw notFound('Asset');
  return a;
}

export interface ScheduleInput { kind?: string; title?: string | null; nextDue?: string; repeat?: string; remindDays?: number | string; vendor?: string | null; notes?: string | null }

export async function addSchedule(db: Database, companyId: string, assetId: string, s: ScheduleInput, userId: string) {
  const a = await asset(db, companyId, assetId);
  if (!a.active) throw invalid('This asset is retired');
  const kind = s.kind ?? 'SERVICE';
  if (!KINDS.has(kind)) throw invalid('Unknown upkeep type');
  const nextDue = optDate(s.nextDue, 'Due date');
  if (!nextDue) throw invalid('Enter when it is next due');
  const repeat = s.repeat ?? 'YEARLY';
  if (!REPEATS.has(repeat)) throw invalid('Repeat must be none, monthly, quarterly, half-yearly or yearly');
  const remind = s.remindDays === undefined || s.remindDays === '' ? 15 : Number(s.remindDays);
  if (!Number.isInteger(remind) || remind < 0 || remind > 90) throw invalid('Remind between 0 and 90 days before');
  const row = await one<{ id: string }>(db,
    `INSERT INTO asset_schedules (asset_id, company_id, kind, title, next_due, repeat, remind_days, vendor, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [assetId, companyId, kind, text(s.title, 200) ?? KIND_LABEL[kind], nextDue, repeat, remind, text(s.vendor, 200), text(s.notes, 1000)]);
  await audit(db, companyId, userId, 'MANUAL', 'CREATE', 'asset_schedule', row.id, null, { asset: a.name, kind, nextDue, repeat, remind });
  return row;
}

export async function removeSchedule(db: Database, companyId: string, scheduleId: string, userId: string) {
  const s = await maybeOne<{ title: string }>(db, `SELECT title FROM asset_schedules WHERE id = $1 AND company_id = $2 AND active`, [scheduleId, companyId]);
  if (!s) throw notFound('Upkeep schedule');
  await db.query(`UPDATE asset_schedules SET active = false WHERE id = $1`, [scheduleId]);
  await audit(db, companyId, userId, 'MANUAL', 'DELETE', 'asset_schedule', scheduleId, { title: s.title }, null);
}

/** Active schedules as calendar reminders ("Generator — AMC renewal"). */
export async function assetScheduleRows(db: Db, companyId: string): Promise<TaskRow[]> {
  return many<TaskRow>(db,
    `SELECT s.id, a.name || ' — ' || s.title AS title,
            s.kind AS category, s.next_due::text AS first_due, s.repeat, s.remind_days, COALESCE(s.vendor, s.notes) AS notes
       FROM asset_schedules s JOIN assets a ON a.id = s.asset_id WHERE s.company_id = $1 AND s.active AND a.active`, [companyId]);
}

const REPAIRS = 'Repairs & Maintenance';
async function repairsLedger(db: Database, companyId: string, userId: string): Promise<string> {
  const l = await maybeOne<{ id: string }>(db, `SELECT id FROM ledgers WHERE company_id = $1 AND lower(name) = lower($2)`, [companyId, REPAIRS]);
  if (l) return l.id;
  const group = await groupByCode(db, companyId, 'INDIRECT_EXPENSES');
  return (await createLedger(db, companyId, { name: REPAIRS, groupId: group.id }, userId)).id;
}

export interface LogInput {
  date?: string; kind?: string; description?: string; cost?: string | null; vendor?: string | null;
  /** The calendar occurrence this completes (e.g. "ASSET:<schedule>:2026-11-30"); it is marked done. */
  scheduleKey?: string | null;
  /** Post the cost as an expense paid from this cash / bank / petty cash ledger. */
  paidFromLedgerId?: string | null;
  expenseLedgerId?: string | null;
  gstRate?: string | null;
  billNo?: string | null;
  confirmWarnings?: boolean;
}

/** Records a repair or service; can post its cost (GST included) and tick off the calendar reminder it settles. */
export async function logUpkeep(db: Database, companyId: string, assetId: string, g: LogInput, opts: { idempotencyKey: string; userId: string }) {
  const a = await asset(db, companyId, assetId);
  const date = optDate(g.date, 'Date');
  if (!date) throw invalid('Enter the date');
  if (date > todayIST()) throw invalid('The date cannot be in the future');
  const kind = g.kind ?? 'REPAIR';
  if (!LOG_KINDS.has(kind)) throw invalid('Unknown upkeep type');
  const description = text(g.description, 500);
  if (!description) throw invalid('Describe what was done');
  const cost = optMoney(g.cost, 'cost');
  if (g.scheduleKey && !g.scheduleKey.startsWith('ASSET:')) throw invalid('Unknown upkeep reminder');

  let voucher: { id: string; voucherNo: string } | null = null;
  if (g.paidFromLedgerId) {
    if (!cost || cost <= 0n) throw invalid('Enter the cost to post it');
    const ctx = await LedgerContext.load(db, companyId);
    if (!ctx.isCashBank(g.paidFromLedgerId)) throw invalid('Choose the cash, bank or petty cash ledger it was paid from');
    voucher = await postExpense(db, companyId, {
      date, expenseLedgerId: g.expenseLedgerId || await repairsLedger(db, companyId, opts.userId), amount: fromMinor(cost), gstRate: g.gstRate,
      paidFromLedgerId: g.paidFromLedgerId, paidTo: g.vendor, billNo: g.billNo, narration: `${a.name}: ${description}`,
    }, { idempotencyKey: opts.idempotencyKey, userId: opts.userId, confirmWarnings: g.confirmWarnings });
  }
  const row = await one<{ id: string }>(db,
    `INSERT INTO asset_logs (asset_id, company_id, log_date, kind, description, cost_minor, voucher_id, vendor, logged_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [assetId, companyId, date, kind, description, cost, voucher?.id ?? null, text(g.vendor, 200), opts.userId]);
  await audit(db, companyId, opts.userId, 'MANUAL', 'CREATE', 'asset_log', row.id, null, { asset: a.name, date, kind, description, cost: cost === null ? null : fromMinor(cost), voucher: voucher?.voucherNo ?? null });
  if (g.scheduleKey) {
    await saveRecord(db, companyId, g.scheduleKey, { doneOn: date, reference: voucher?.voucherNo ?? null, amount: cost === null ? null : fromMinor(cost), notes: description }, opts.userId);
  }
  return { id: row.id, voucher };
}
