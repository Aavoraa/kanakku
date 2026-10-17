import type { PGlite } from '@electric-sql/pglite';
import { maybeOne, one, type Db } from '../db/client';
import { AppError, invalid, notFound } from '../lib/errors';
import { isValidGstin, gstinPan, gstinState } from '../lib/gstin';
import { fromMinor, percentToPpm } from '../lib/money';
import { normName } from '../lib/text';
import { audit } from './post';
import { groupByCode, REG_TYPES } from './masters';

/**
 * Altering masters: ledgers, parties, stock items and groups.
 * Vouchers point at them by id, so a rename shows everywhere at once (the hash chain covers ids and amounts, not
 * names). Switching one off hides it from new entries; it is refused while it still carries a balance or stock.
 * Every change is kept in the audit log with before and after.
 */

const ledgerBalance = async (db: Db, ledgerId: string) =>
  (await one<{ s: bigint }>(db, `SELECT COALESCE(SUM(amount_minor), 0)::bigint AS s FROM ledger_entries WHERE ledger_id = $1`, [ledgerId])).s;
const rupees = (v: bigint) => fromMinor(v < 0n ? -v : v);
const PARTY_GROUP_RE = /(^|\.)sundry_(debtors|creditors)(\.|$)/;

async function assertLedgerNameFree(db: Db, companyId: string, name: string, exceptLedgerId: string) {
  if (await maybeOne(db, `SELECT 1 FROM ledgers WHERE company_id = $1 AND lower(name) = lower($2) AND id <> $3`, [companyId, name, exceptLedgerId])) {
    throw new AppError('DUPLICATE_NAME', 409, `A ledger named "${name}" already exists`);
  }
}

export interface LedgerPatch { name?: string; groupId?: string; active?: boolean }

export async function updateLedger(db: PGlite, companyId: string, ledgerId: string, p: LedgerPatch, userId: string) {
  const l = await maybeOne<{ id: string; name: string; group_id: string; is_active: boolean; system_code: string | null; tax_component: string | null; counterparty_id: string | null }>(db,
    `SELECT id, name, group_id, is_active, system_code, tax_component, counterparty_id FROM ledgers WHERE id = $1 AND company_id = $2`, [ledgerId, companyId]);
  if (!l) throw notFound('Ledger');
  if (l.counterparty_id) throw invalid('This is a party ledger: change it under Parties');
  if (l.tax_component) throw invalid('GST and TDS ledgers are set up by Kannaku AI and cannot be changed');
  const petty = Boolean(await maybeOne(db, `SELECT 1 FROM petty_cash_boxes WHERE ledger_id = $1 AND active`, [ledgerId]));

  const name = p.name === undefined ? l.name : String(p.name).trim();
  if (!name) throw invalid('Ledger name is required');
  if (name.toLowerCase() !== l.name.toLowerCase()) await assertLedgerNameFree(db, companyId, name, ledgerId);

  let groupId = l.group_id;
  if (p.groupId !== undefined && p.groupId !== l.group_id) {
    if (l.system_code) throw invalid(`${l.name} is a standard ledger; its group cannot change`);
    if (petty) throw invalid('A petty cash ledger stays under Cash-in-Hand');
    const g = await maybeOne<{ id: string; path: string }>(db, `SELECT id, path::text FROM ledger_groups WHERE id = $1 AND company_id = $2`, [p.groupId, companyId]);
    if (!g) throw notFound('Group');
    if (PARTY_GROUP_RE.test(g.path)) throw invalid('Customers and suppliers are created as parties, not moved in as ledgers');
    groupId = g.id;
  }

  let active = l.is_active;
  if (p.active !== undefined && Boolean(p.active) !== l.is_active) {
    if (!p.active) {
      if (l.system_code) throw invalid(`${l.name} is a standard ledger and cannot be switched off`);
      if (petty) throw invalid('This is a petty cash box; it cannot be switched off here');
      const bal = await ledgerBalance(db, ledgerId);
      if (bal !== 0n) throw new AppError('HAS_BALANCE', 409, `${l.name} still has a balance of ₹${rupees(bal)}. Bring it to zero before switching it off.`);
    }
    active = Boolean(p.active);
  }
  await db.query(`UPDATE ledgers SET name = $2, norm_name = $3, group_id = $4, is_active = $5 WHERE id = $1`, [ledgerId, name, normName(name), groupId, active]);
  await audit(db, companyId, userId, 'MANUAL', 'UPDATE', 'ledger', ledgerId, { name: l.name, groupId: l.group_id, active: l.is_active }, { name, groupId, active });
  return { id: ledgerId, name, groupId, active };
}

export interface PartyPatch {
  name?: string; kind?: 'CUSTOMER' | 'SUPPLIER'; gstin?: string | null; stateCode?: string | null; city?: string | null; phone?: string | null;
  creditDays?: number | string | null; regType?: string | null; active?: boolean;
}

export async function updateParty(db: PGlite, companyId: string, partyId: string, p: PartyPatch, userId: string) {
  const cp = await maybeOne<{ legal_name: string; gstin: string | null; state_code: string | null; city: string | null; phone: string | null; credit_days: number | null; gst_reg_type: string; status: string }>(db,
    `SELECT legal_name, gstin, state_code, city, phone, credit_days, gst_reg_type, status FROM counterparties WHERE id = $1 AND company_id = $2`, [partyId, companyId]);
  if (!cp) throw notFound('Party');
  const ledger = await one<{ id: string; group_id: string; path: string }>(db,
    `SELECT l.id, l.group_id, g.path::text AS path FROM ledgers l JOIN ledger_groups g ON g.id = l.group_id WHERE l.counterparty_id = $1`, [partyId]);

  const name = p.name === undefined ? cp.legal_name : String(p.name).trim();
  if (!name) throw invalid('Party name is required');
  if (name.toLowerCase() !== cp.legal_name.toLowerCase()) await assertLedgerNameFree(db, companyId, name, ledger.id);

  let gstin = cp.gstin;
  if (p.gstin !== undefined) {
    gstin = p.gstin?.trim().toUpperCase() || null;
    if (gstin && !isValidGstin(gstin)) throw invalid(`GSTIN ${gstin} is not valid (check digit or format)`);
    if (gstin && gstin !== cp.gstin) {
      const dup = await maybeOne<{ legal_name: string }>(db, `SELECT legal_name FROM counterparties WHERE company_id = $1 AND gstin = $2 AND id <> $3`, [companyId, gstin, partyId]);
      if (dup) throw new AppError('DUPLICATE_GSTIN', 409, `GSTIN ${gstin} already belongs to ${dup.legal_name}`);
    }
  }
  // With a GSTIN the state is the GSTIN's; without one, the state chosen.
  const stateCode = gstin ? gstinState(gstin) : p.stateCode !== undefined ? (p.stateCode || null) : cp.state_code;
  let regType = p.regType ? p.regType : cp.gst_reg_type;
  if (!REG_TYPES.has(regType)) throw invalid('Unknown GST registration type');
  // Adding or removing the GSTIN moves a plain party between registered and unregistered.
  if (p.gstin !== undefined && !p.regType && (regType === 'REGULAR' || regType === 'UNREGISTERED')) regType = gstin ? 'REGULAR' : 'UNREGISTERED';
  const creditDays = p.creditDays === undefined ? cp.credit_days : p.creditDays === null || p.creditDays === '' ? null : Number(p.creditDays);
  if (creditDays !== null && (!Number.isInteger(creditDays) || creditDays < 0 || creditDays > 365)) throw invalid('Credit days must be a whole number from 0 to 365');

  let groupId = ledger.group_id;
  if (p.kind && PARTY_GROUP_RE.test(ledger.path)) {
    const want = p.kind === 'CUSTOMER' ? 'sundry_debtors' : 'sundry_creditors';
    if (!ledger.path.split('.').includes(want)) groupId = (await groupByCode(db, companyId, want.toUpperCase())).id;
  }

  let status = cp.status;
  if (p.active === false && cp.status !== 'INACTIVE') {
    const bal = await ledgerBalance(db, ledger.id);
    if (bal !== 0n) throw new AppError('HAS_BALANCE', 409, `${cp.legal_name} still has a balance of ₹${rupees(bal)}. Settle it before switching the party off.`);
    status = 'INACTIVE';
  } else if (p.active === true && cp.status === 'INACTIVE') status = 'ACTIVE';

  const next = {
    name, gstin, stateCode, regType, creditDays, status, groupId,
    city: p.city === undefined ? cp.city : p.city?.trim() || null,
    phone: p.phone === undefined ? cp.phone : p.phone?.trim() || null,
  };
  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE counterparties SET legal_name = $2, norm_name = $3, gstin = $4, pan = $5, gst_reg_type = $6, state_code = $7, city = $8, phone = $9, credit_days = $10, status = $11 WHERE id = $1`,
      [partyId, name, normName(name), gstin, gstin ? gstinPan(gstin) : null, regType, stateCode, next.city, next.phone, creditDays, status]);
    await tx.query(`UPDATE ledgers SET name = $2, norm_name = $3, group_id = $4, is_active = $5 WHERE id = $1`, [ledger.id, name, normName(name), groupId, status !== 'INACTIVE']);
    await audit(tx, companyId, userId, 'MANUAL', 'UPDATE', 'party', partyId,
      { name: cp.legal_name, gstin: cp.gstin, stateCode: cp.state_code, regType: cp.gst_reg_type, city: cp.city, phone: cp.phone, creditDays: cp.credit_days, status: cp.status, groupId: ledger.group_id }, next);
  });
  return { id: partyId, ...next };
}

export interface ItemPatch { name?: string; hsnSac?: string | null; gstRate?: string | null; uomId?: string; valuation?: 'FIFO' | 'WAVG'; allowNegative?: boolean; active?: boolean }

export async function updateItem(db: PGlite, companyId: string, itemId: string, p: ItemPatch, userId: string) {
  const it = await maybeOne<{ name: string; hsn_sac: string | null; gst_rate_ppm: number | null; base_uom_id: string; valuation: string; allow_negative: boolean; is_active: boolean }>(db,
    `SELECT name, hsn_sac, gst_rate_ppm, base_uom_id, valuation, allow_negative, is_active FROM stock_items WHERE id = $1 AND company_id = $2`, [itemId, companyId]);
  if (!it) throw notFound('Stock item');
  const name = p.name === undefined ? it.name : String(p.name).trim();
  if (!name) throw invalid('Item name is required');
  if (name.toLowerCase() !== it.name.toLowerCase()
    && await maybeOne(db, `SELECT 1 FROM stock_items WHERE company_id = $1 AND lower(name) = lower($2) AND id <> $3`, [companyId, name, itemId])) {
    throw new AppError('DUPLICATE_NAME', 409, `An item named "${name}" already exists`);
  }
  const hsn = p.hsnSac === undefined ? it.hsn_sac : p.hsnSac?.trim() || null;
  if (hsn && !/^\d{4,8}$/.test(hsn)) throw invalid('HSN/SAC must be 4 to 8 digits');
  const rate = p.gstRate === undefined ? it.gst_rate_ppm : p.gstRate === null || p.gstRate === '' ? null : percentToPpm(p.gstRate);
  const uomId = p.uomId ?? it.base_uom_id;
  const valuation = p.valuation ?? it.valuation;
  if (valuation !== 'FIFO' && valuation !== 'WAVG') throw invalid('Valuation must be FIFO or weighted average');
  // A new unit or valuation method would re-read every past quantity and cost; allowed only before first use.
  if (uomId !== it.base_uom_id || valuation !== it.valuation) {
    if (await maybeOne(db, `SELECT 1 FROM inventory_entries WHERE item_id = $1 LIMIT 1`, [itemId])) {
      throw invalid('The unit and valuation method cannot change once the item has stock movements');
    }
    if (!(await maybeOne(db, `SELECT 1 FROM uoms WHERE id = $1 AND company_id = $2`, [uomId, companyId]))) throw notFound('Unit');
  }
  let active = it.is_active;
  if (p.active !== undefined && Boolean(p.active) !== it.is_active) {
    if (!p.active) {
      const q = await one<{ q: string }>(db, `SELECT COALESCE(SUM(qty), 0)::text AS q FROM inventory_entries WHERE item_id = $1`, [itemId]);
      if (Number(q.q) !== 0) throw new AppError('HAS_STOCK', 409, `${it.name} still has ${q.q} in stock. Bring it to zero before switching it off.`);
    }
    active = Boolean(p.active);
  }
  const allowNegative = p.allowNegative === undefined ? it.allow_negative : Boolean(p.allowNegative);
  await db.query(
    `UPDATE stock_items SET name = $2, norm_name = $3, hsn_sac = $4, gst_rate_ppm = $5, base_uom_id = $6, valuation = $7, allow_negative = $8, is_active = $9 WHERE id = $1`,
    [itemId, name, normName(name), hsn, rate, uomId, valuation, allowNegative, active]);
  const next = { name, hsnSac: hsn, gstRatePpm: rate, uomId, valuation, allowNegative, active };
  await audit(db, companyId, userId, 'MANUAL', 'UPDATE', 'item', itemId,
    { name: it.name, hsnSac: it.hsn_sac, gstRatePpm: it.gst_rate_ppm, uomId: it.base_uom_id, valuation: it.valuation, allowNegative: it.allow_negative, active: it.is_active }, next);
  return { id: itemId, ...next };
}

/** Renames a group the company created (the 28 standard groups keep their names). */
export async function renameGroup(db: PGlite, companyId: string, groupId: string, nameRaw: unknown, userId: string) {
  const g = await maybeOne<{ name: string; system_code: string | null }>(db, `SELECT name, system_code FROM ledger_groups WHERE id = $1 AND company_id = $2`, [groupId, companyId]);
  if (!g) throw notFound('Group');
  if (g.system_code) throw invalid(`${g.name} is a standard group and keeps its name`);
  const name = String(nameRaw ?? '').trim().slice(0, 120);
  if (!name) throw invalid('Group name is required');
  if (await maybeOne(db, `SELECT 1 FROM ledger_groups WHERE company_id = $1 AND lower(name) = lower($2) AND id <> $3`, [companyId, name, groupId])) {
    throw new AppError('DUPLICATE_NAME', 409, `A group named "${name}" already exists`);
  }
  await db.query(`UPDATE ledger_groups SET name = $2 WHERE id = $1`, [groupId, name]);
  await audit(db, companyId, userId, 'MANUAL', 'UPDATE', 'group', groupId, { name: g.name }, { name });
  return { id: groupId, name };
}
