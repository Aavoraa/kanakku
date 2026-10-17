import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { many, maybeOne, one, type Db } from '../db/client';
import { AppError, invalid, notFound } from '../lib/errors';
import { addDays } from '../lib/dates';
import { isValidGstin, gstinPan, gstinState } from '../lib/gstin';
import { fromMinor, percentToPpm, toMinor } from '../lib/money';
import { normName } from '../lib/text';
import { audit, postVoucher } from './post';

type Nature = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'EXPENSE';

/** Tally's 28 predefined groups. Labels double as ltree path segments. */
const STANDARD_GROUPS: { code: string; name: string; nature: Nature; parent?: string; gp?: boolean; order: number }[] = [
  { code: 'capital_account', name: 'Capital Account', nature: 'EQUITY', order: 10 },
  { code: 'reserves_surplus', name: 'Reserves & Surplus', nature: 'EQUITY', parent: 'capital_account', order: 11 },
  { code: 'loans_liability', name: 'Loans (Liability)', nature: 'LIABILITY', order: 20 },
  { code: 'bank_od', name: 'Bank OD A/c', nature: 'LIABILITY', parent: 'loans_liability', order: 21 },
  { code: 'secured_loans', name: 'Secured Loans', nature: 'LIABILITY', parent: 'loans_liability', order: 22 },
  { code: 'unsecured_loans', name: 'Unsecured Loans', nature: 'LIABILITY', parent: 'loans_liability', order: 23 },
  { code: 'current_liabilities', name: 'Current Liabilities', nature: 'LIABILITY', order: 30 },
  { code: 'duties_taxes', name: 'Duties & Taxes', nature: 'LIABILITY', parent: 'current_liabilities', order: 31 },
  { code: 'provisions', name: 'Provisions', nature: 'LIABILITY', parent: 'current_liabilities', order: 32 },
  { code: 'sundry_creditors', name: 'Sundry Creditors', nature: 'LIABILITY', parent: 'current_liabilities', order: 33 },
  { code: 'branch_divisions', name: 'Branch / Divisions', nature: 'LIABILITY', order: 40 },
  { code: 'suspense', name: 'Suspense A/c', nature: 'LIABILITY', order: 41 },
  { code: 'fixed_assets', name: 'Fixed Assets', nature: 'ASSET', order: 50 },
  { code: 'investments', name: 'Investments', nature: 'ASSET', order: 51 },
  { code: 'current_assets', name: 'Current Assets', nature: 'ASSET', order: 52 },
  { code: 'bank_accounts', name: 'Bank Accounts', nature: 'ASSET', parent: 'current_assets', order: 53 },
  { code: 'cash_in_hand', name: 'Cash-in-Hand', nature: 'ASSET', parent: 'current_assets', order: 54 },
  { code: 'deposits', name: 'Deposits (Asset)', nature: 'ASSET', parent: 'current_assets', order: 55 },
  { code: 'loans_advances', name: 'Loans & Advances (Asset)', nature: 'ASSET', parent: 'current_assets', order: 56 },
  { code: 'stock_in_hand', name: 'Stock-in-Hand', nature: 'ASSET', parent: 'current_assets', order: 57 },
  { code: 'sundry_debtors', name: 'Sundry Debtors', nature: 'ASSET', parent: 'current_assets', order: 58 },
  { code: 'misc_expenses_asset', name: 'Misc. Expenses (Asset)', nature: 'ASSET', order: 59 },
  { code: 'sales_accounts', name: 'Sales Accounts', nature: 'INCOME', gp: true, order: 60 },
  { code: 'direct_incomes', name: 'Direct Incomes', nature: 'INCOME', gp: true, order: 61 },
  { code: 'purchase_accounts', name: 'Purchase Accounts', nature: 'EXPENSE', gp: true, order: 70 },
  { code: 'direct_expenses', name: 'Direct Expenses', nature: 'EXPENSE', gp: true, order: 71 },
  { code: 'indirect_incomes', name: 'Indirect Incomes', nature: 'INCOME', order: 80 },
  { code: 'indirect_expenses', name: 'Indirect Expenses', nature: 'EXPENSE', order: 81 },
];

const SYSTEM_LEDGERS: { code: string; name: string; group: string }[] = [
  { code: 'CASH', name: 'Cash', group: 'cash_in_hand' },
  { code: 'SALES', name: 'Sales', group: 'sales_accounts' },
  { code: 'PURCHASE', name: 'Purchase', group: 'purchase_accounts' },
  { code: 'ROUND_OFF', name: 'Round Off', group: 'indirect_expenses' },
  { code: 'PL_ACCOUNT', name: 'Profit & Loss A/c', group: 'reserves_surplus' },
  { code: 'OPENING_DIFF', name: 'Difference in Opening Balances', group: 'suspense' },
];

const VOUCHER_TYPES: [string, string][] = [
  ['Sales', 'SALES'], ['Purchase', 'PURCHASE'], ['Payment', 'PAYMENT'], ['Receipt', 'RECEIPT'],
  ['Journal', 'JOURNAL'], ['Contra', 'CONTRA'], ['Credit Note', 'CREDIT_NOTE'], ['Debit Note', 'DEBIT_NOTE'],
  ['Opening Balance', 'OPENING'],
];

const UOMS: [string, string, number][] = [
  ['Nos', 'NOS', 0], ['Pcs', 'PCS', 0], ['Bag', 'BAG', 0], ['Box', 'BOX', 0], ['Kg', 'KGS', 3],
  ['Ton', 'MTS', 3], ['Ltr', 'LTR', 3], ['Mtr', 'MTR', 2], ['Set', 'SET', 0],
];

export interface NewCompany {
  name: string;
  gstin?: string | null;
  stateCode: string;
  booksFrom: string;
}

export async function createCompany(db: PGlite, c: NewCompany): Promise<string> {
  if (c.gstin && !isValidGstin(c.gstin)) throw invalid('GSTIN is not valid');
  return db.transaction(async (tx) => {
    const company = await one<{ id: string }>(tx,
      `INSERT INTO companies (tenant_id, name, gstin, state_code, books_from) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [crypto.randomUUID(), c.name, c.gstin ?? null, c.stateCode, c.booksFrom]);
    const ids = new Map<string, string>();
    for (const g of STANDARD_GROUPS) {
      const path = g.parent ? `${g.parent}.${g.code}` : g.code;
      const row = await one<{ id: string }>(tx,
        `INSERT INTO ledger_groups (company_id, parent_id, name, nature, affects_gross_profit, system_code, path, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7::ltree,$8) RETURNING id`,
        [company.id, g.parent ? ids.get(g.parent) : null, g.name, g.nature, Boolean(g.gp), g.code.toUpperCase(), path, g.order]);
      ids.set(g.code, row.id);
    }
    for (const l of SYSTEM_LEDGERS) {
      await tx.query(
        `INSERT INTO ledgers (company_id, group_id, name, norm_name, system_code) VALUES ($1,$2,$3,$4,$5)`,
        [company.id, ids.get(l.group), l.name, normName(l.name), l.code]);
    }
    for (const [name, base] of VOUCHER_TYPES) {
      await tx.query(`INSERT INTO voucher_types (company_id, name, base_type) VALUES ($1,$2,$3)`, [company.id, name, base]);
    }
    for (const [symbol, uqc, decimals] of UOMS) {
      await tx.query(`INSERT INTO uoms (company_id, symbol, uqc, decimals) VALUES ($1,$2,$3,$4)`, [company.id, symbol, uqc, decimals]);
    }
    await tx.query(`INSERT INTO godowns (company_id, name, is_default) VALUES ($1, 'Main Location', true)`, [company.id]);
    return company.id;
  });
}

export async function groupByCode(db: Db, companyId: string, code: string) {
  const g = await maybeOne<{ id: string; path: string; nature: Nature }>(db,
    `SELECT id, path::text, nature FROM ledger_groups WHERE company_id = $1 AND system_code = $2`, [companyId, code.toUpperCase()]);
  if (!g) throw notFound(`Group ${code}`);
  return g;
}

export async function createGroup(db: Db, companyId: string, g: { name: string; parentId: string }) {
  const parent = await maybeOne<{ path: string; nature: Nature; affects_gross_profit: boolean }>(db,
    `SELECT path::text, nature, affects_gross_profit FROM ledger_groups WHERE id = $1 AND company_id = $2`, [g.parentId, companyId]);
  if (!parent) throw notFound('Parent group');
  const label = `${normName(g.name).replace(/ /g, '_').slice(0, 40) || 'group'}_${crypto.randomUUID().slice(0, 6)}`;
  return one<{ id: string }>(db,
    `INSERT INTO ledger_groups (company_id, parent_id, name, nature, affects_gross_profit, path)
     VALUES ($1,$2,$3,$4,$5,$6::ltree) RETURNING id`,
    [companyId, g.parentId, g.name, parent.nature, parent.affects_gross_profit, `${parent.path}.${label}`]);
}

export async function createLedger(db: PGlite, companyId: string, l: {
  name: string; groupId: string; openingBalance?: string | null; openingSide?: 'DR' | 'CR'; billWise?: boolean;
}, userId: string) {
  const name = l.name.trim();
  if (!name) throw invalid('Ledger name is required');
  const exists = await maybeOne(db, `SELECT 1 FROM ledgers WHERE company_id = $1 AND lower(name) = lower($2)`, [companyId, name]);
  if (exists) throw new AppError('DUPLICATE_NAME', 409, `A ledger named "${name}" already exists`);
  const row = await one<{ id: string }>(db,
    `INSERT INTO ledgers (company_id, group_id, name, norm_name, bill_wise) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [companyId, l.groupId, name, normName(name), Boolean(l.billWise)]);
  await audit(db, companyId, userId, 'MANUAL', 'CREATE', 'ledger', row.id, null, l);
  if (l.openingBalance && toMinor(l.openingBalance) !== 0n) {
    await setOpeningBalance(db, companyId, row.id, toMinor(l.openingBalance) * (l.openingSide === 'CR' ? -1n : 1n), userId);
  }
  return row;
}

export interface NewParty {
  name: string;
  kind: 'CUSTOMER' | 'SUPPLIER';
  gstin?: string | null;
  stateCode?: string | null;
  city?: string | null;
  phone?: string | null;
  creditDays?: number | null;
  openingBalance?: string | null;   // + receivable for customers / payable for suppliers
  status?: 'ACTIVE' | 'PROVISIONAL';
  /** Only needed for parties that are not plain registered / unregistered businesses. */
  regType?: 'REGULAR' | 'COMPOSITION' | 'UNREGISTERED' | 'CONSUMER' | 'SEZ' | 'OVERSEAS' | null;
}

const REG_TYPES = new Set(['REGULAR', 'COMPOSITION', 'UNREGISTERED', 'CONSUMER', 'SEZ', 'OVERSEAS']);

export async function createParty(db: PGlite, companyId: string, p: NewParty, userId: string, channel = 'MANUAL') {
  const name = p.name.trim();
  if (!name) throw invalid('Party name is required');
  const gstin = p.gstin?.trim().toUpperCase() || null;
  if (gstin && !isValidGstin(gstin)) throw invalid(`GSTIN ${gstin} is not valid (check digit or format)`);
  if (gstin) {
    const dup = await maybeOne<{ legal_name: string }>(db, `SELECT legal_name FROM counterparties WHERE company_id = $1 AND gstin = $2`, [companyId, gstin]);
    if (dup) throw new AppError('DUPLICATE_GSTIN', 409, `GSTIN ${gstin} already belongs to ${dup.legal_name}`);
  }
  const nameTaken = await maybeOne(db, `SELECT 1 FROM ledgers WHERE company_id = $1 AND lower(name) = lower($2)`, [companyId, name]);
  if (nameTaken) throw new AppError('DUPLICATE_NAME', 409, `A ledger named "${name}" already exists`);

  if (p.regType && !REG_TYPES.has(p.regType)) throw invalid('Unknown GST registration type');
  const regType = p.regType || (gstin ? 'REGULAR' : 'UNREGISTERED');
  const group = await groupByCode(db, companyId, p.kind === 'CUSTOMER' ? 'SUNDRY_DEBTORS' : 'SUNDRY_CREDITORS');
  const result = await db.transaction(async (tx) => {
    const cp = await one<{ id: string }>(tx,
      `INSERT INTO counterparties (company_id, legal_name, norm_name, gstin, pan, gst_reg_type, state_code, city, phone, credit_days, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [companyId, name, normName(name), gstin, gstin ? gstinPan(gstin) : null, regType,
        gstin ? gstinState(gstin) : p.stateCode ?? null, p.city ?? null, p.phone ?? null, p.creditDays ?? null, p.status ?? 'ACTIVE']);
    const ledger = await one<{ id: string }>(tx,
      `INSERT INTO ledgers (company_id, group_id, name, norm_name, counterparty_id, bill_wise) VALUES ($1,$2,$3,$4,$5,true) RETURNING id`,
      [companyId, group.id, name, normName(name), cp.id]);
    await audit(tx, companyId, userId, channel, 'CREATE', 'party', cp.id, null, p);
    return { id: cp.id, ledgerId: ledger.id };
  });
  if (p.openingBalance && toMinor(p.openingBalance) !== 0n) {
    const amt = toMinor(p.openingBalance);
    await setOpeningBalance(db, companyId, result.ledgerId, p.kind === 'CUSTOMER' ? amt : -amt, userId);
  }
  return result;
}

/** Posts an Opening Balance voucher for the difference between the current and target opening. */
export async function setOpeningBalance(db: PGlite, companyId: string, ledgerId: string, targetMinor: bigint, userId: string) {
  const company = await one<{ books_from: string }>(db, `SELECT books_from::text FROM companies WHERE id = $1`, [companyId]);
  const current = await one<{ s: bigint | null }>(db,
    `SELECT SUM(e.amount_minor) AS s FROM ledger_entries e JOIN vouchers v ON v.id = e.voucher_id
       JOIN voucher_types t ON t.id = v.voucher_type_id
      WHERE e.ledger_id = $1 AND t.base_type = 'OPENING'`, [ledgerId]);
  const delta = targetMinor - (current.s ?? 0n);
  if (delta === 0n) return null;
  const diff = await one<{ id: string }>(db, `SELECT id FROM ledgers WHERE company_id = $1 AND system_code = 'OPENING_DIFF'`, [companyId]);
  const amount = fromMinor(delta < 0n ? -delta : delta);
  return postVoucher(db, companyId, {
    voucherType: 'OPENING',
    date: addDays(company.books_from, -1),
    narration: 'Opening balance',
    entries: [
      { ledgerId, side: delta > 0n ? 'DR' : 'CR', amount },
      { ledgerId: diff.id, side: delta > 0n ? 'CR' : 'DR', amount },
    ],
  }, { source: 'MANUAL', idempotencyKey: `opening:${ledgerId}:${crypto.randomUUID()}`, userId });
}

export interface NewItem {
  name: string;
  uomId: string;
  hsnSac?: string | null;
  gstRate?: string | null;
  valuation?: 'FIFO' | 'WAVG';
  aliases?: string[];
}

export async function createItem(db: Db, companyId: string, i: NewItem, userId: string) {
  const name = i.name.trim();
  if (!name) throw invalid('Item name is required');
  if (i.hsnSac && !/^\d{4,8}$/.test(i.hsnSac)) throw invalid('HSN/SAC must be 4 to 8 digits');
  const dup = await maybeOne(db, `SELECT 1 FROM stock_items WHERE company_id = $1 AND lower(name) = lower($2)`, [companyId, name]);
  if (dup) throw new AppError('DUPLICATE_NAME', 409, `An item named "${name}" already exists`);
  const row = await one<{ id: string }>(db,
    `INSERT INTO stock_items (company_id, name, norm_name, aliases, base_uom_id, hsn_sac, gst_rate_ppm, valuation)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [companyId, name, normName(name), i.aliases ?? [], i.uomId, i.hsnSac ?? null,
      i.gstRate ? percentToPpm(i.gstRate) : null, i.valuation ?? 'WAVG']);
  await audit(db, companyId, userId, 'MANUAL', 'CREATE', 'item', row.id, null, i);
  return row;
}

export async function listGroups(db: Db, companyId: string) {
  return many(db,
    `SELECT id, parent_id AS "parentId", name, nature, affects_gross_profit AS "affectsGrossProfit", system_code AS "systemCode", path::text
       FROM ledger_groups WHERE company_id = $1 ORDER BY sort_order, path`, [companyId]);
}
