import { many, maybeOne, one, type Db } from '../db/client';
import { AppError, notFound } from '../lib/errors';
import { normName } from '../lib/text';

export interface Company {
  id: string;
  name: string;
  gstin: string | null;
  state_code: string;
  fy_start_month: number;
  books_from: string;
  lock_date: string | null;
  round_invoice: boolean;
  voice_limit_minor: bigint;
  journal_allows_cash: boolean;
}

export interface LedgerInfo {
  id: string;
  name: string;
  groupId: string;
  groupName: string;
  path: string[];          // ltree labels, e.g. ['current_assets','sundry_debtors']
  nature: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'EXPENSE';
  counterpartyId: string | null;
  billWise: boolean;
  systemCode: string | null;
  taxComponent: string | null;
  taxDirection: string | null;
  taxRatePpm: number | null;
  /** Switched off in Masters: kept for history, refused for new entries. */
  active: boolean;
}

export interface Party {
  id: string;
  legal_name: string;
  gstin: string | null;
  state_code: string | null;
  credit_days: number | null;
  gst_reg_type: string;
}

const CASH_BANK = ['cash_in_hand', 'bank_accounts', 'bank_od'];

export class LedgerContext {
  constructor(
    public db: Db,
    public company: Company,
    private ledgers: Map<string, LedgerInfo>,
  ) {}

  static async load(db: Db, companyId: string): Promise<LedgerContext> {
    const company = await maybeOne<Company>(db,
      `SELECT id, name, gstin, state_code, fy_start_month, books_from::text, lock_date::text,
              round_invoice, voice_limit_minor, journal_allows_cash
         FROM companies WHERE id = $1`, [companyId]);
    if (!company) throw notFound('Company');
    const rows = await many<{
      id: string; name: string; group_id: string; group_name: string; path: string; nature: LedgerInfo['nature'];
      counterparty_id: string | null; bill_wise: boolean; system_code: string | null;
      tax_component: string | null; tax_direction: string | null; tax_rate_ppm: number | null; is_active: boolean;
    }>(db,
      `SELECT l.id, l.name, l.group_id, g.name AS group_name, g.path::text AS path, g.nature,
              l.counterparty_id, l.bill_wise, l.system_code, l.tax_component, l.tax_direction, l.tax_rate_ppm, l.is_active
         FROM ledgers l JOIN ledger_groups g ON g.id = l.group_id
        WHERE l.company_id = $1`, [companyId]);
    const map = new Map<string, LedgerInfo>();
    for (const r of rows) {
      map.set(r.id, {
        id: r.id, name: r.name, groupId: r.group_id, groupName: r.group_name, path: r.path.split('.'),
        nature: r.nature, counterpartyId: r.counterparty_id, billWise: r.bill_wise, systemCode: r.system_code,
        taxComponent: r.tax_component, taxDirection: r.tax_direction, taxRatePpm: r.tax_rate_ppm, active: r.is_active,
      });
    }
    return new LedgerContext(db, company, map);
  }

  ledger(id: string): LedgerInfo {
    const l = this.ledgers.get(id);
    if (!l) throw new AppError('UNKNOWN_LEDGER', 422, `Ledger ${id} does not exist`);
    return l;
  }

  systemLedger(code: string): LedgerInfo {
    for (const l of this.ledgers.values()) if (l.systemCode === code) return l;
    throw new AppError('MISSING_SYSTEM_LEDGER', 500, `System ledger ${code} is missing`);
  }

  isCashBank(id: string) { return this.ledger(id).path.some((p) => CASH_BANK.includes(p)); }
  isDebtor(id: string) { return this.ledger(id).path.includes('sundry_debtors'); }
  isCreditor(id: string) { return this.ledger(id).path.includes('sundry_creditors'); }

  bankLedgers(): LedgerInfo[] {
    return [...this.ledgers.values()].filter((l) => l.path.includes('bank_accounts') || l.path.includes('bank_od'));
  }

  async party(counterpartyId: string): Promise<Party> {
    const p = await maybeOne<Party>(this.db,
      `SELECT id, legal_name, gstin, state_code, credit_days, gst_reg_type FROM counterparties
        WHERE id = $1 AND company_id = $2`, [counterpartyId, this.company.id]);
    if (!p) throw new AppError('UNKNOWN_PARTY', 422, 'Party does not exist');
    return p;
  }

  partyLedger(counterpartyId: string): LedgerInfo {
    for (const l of this.ledgers.values()) if (l.counterpartyId === counterpartyId) return l;
    throw new AppError('PARTY_HAS_NO_LEDGER', 422, 'Party has no ledger');
  }

  /** Tax ledger for (component, direction, rate); created under Duties & Taxes if missing. */
  async taxLedger(component: string, direction: 'INPUT' | 'OUTPUT' | 'RCM_PAYABLE', ratePpm: number): Promise<LedgerInfo> {
    for (const l of this.ledgers.values()) {
      if (l.taxComponent === component && l.taxDirection === direction && l.taxRatePpm === ratePpm) return l;
    }
    const pct = ratePpm / 10_000;
    const prefix = direction === 'INPUT' ? 'Input' : direction === 'OUTPUT' ? 'Output' : 'RCM Payable';
    const name = `${prefix} ${component} ${pct}%`;
    const group = await one<{ id: string; name: string; path: string }>(this.db,
      `SELECT id, name, path::text FROM ledger_groups WHERE company_id = $1 AND system_code = 'DUTIES_TAXES'`,
      [this.company.id]);
    const row = await one<{ id: string }>(this.db,
      `INSERT INTO ledgers (company_id, group_id, name, norm_name, tax_component, tax_direction, tax_rate_ppm)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (company_id, name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [this.company.id, group.id, name, normName(name), component, direction, ratePpm]);
    const info: LedgerInfo = {
      id: row.id, name, groupId: group.id, groupName: group.name, path: group.path.split('.'), nature: 'LIABILITY',
      counterpartyId: null, billWise: false, systemCode: null, taxComponent: component, taxDirection: direction,
      taxRatePpm: ratePpm, active: true,
    };
    this.ledgers.set(row.id, info);
    return info;
  }
}
