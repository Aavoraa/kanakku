import { one, type Database } from './client';
import { addDays, fyStart, todayIST } from '../lib/dates';
import { makeGstin } from '../lib/gstin';
import { createCompany, createItem, createLedger, createParty, groupByCode, setOpeningBalance } from '../ledger/masters';
import { postVoucher } from '../ledger/post';
import { toMinor } from '../lib/money';
import { config } from '../config';

export const DEMO_COMPANY_NAME = 'Sharma Building Supplies';

/** Seeds a small building-materials trader with ~3 months of activity, dated relative to today. */
export async function seedDemo(db: Database): Promise<string> {
  const today = todayIST();
  const d = (n: number) => addDays(today, -n);
  const user = config.localUserId;
  const companyId = await createCompany(db, {
    name: DEMO_COMPANY_NAME,
    gstin: makeGstin('27', 'AAKFS4321K'),
    stateCode: '27',
    booksFrom: fyStart(d(100)),
  });

  const grp = async (code: string) => (await groupByCode(db, companyId, code)).id;
  const ledger = async (name: string, group: string, opening?: [string, 'DR' | 'CR']) =>
    (await createLedger(db, companyId, { name, groupId: await grp(group), openingBalance: opening?.[0], openingSide: opening?.[1] }, user)).id;

  const hdfc = await ledger('HDFC Bank', 'BANK_ACCOUNTS', ['600000', 'DR']);
  await ledger('Ramesh Sharma Capital', 'CAPITAL_ACCOUNT', ['615000', 'CR']);
  const rent = await ledger('Rent', 'INDIRECT_EXPENSES');
  const electricity = await ledger('Electricity', 'INDIRECT_EXPENSES');
  await ledger('Salaries', 'INDIRECT_EXPENSES');
  await ledger('Telephone & Internet', 'INDIRECT_EXPENSES');
  await ledger('Fuel', 'INDIRECT_EXPENSES');
  await ledger('Freight Inward', 'DIRECT_EXPENSES');
  const cash = (await one<{ id: string }>(db, `SELECT id FROM ledgers WHERE company_id = $1 AND system_code = 'CASH'`, [companyId])).id;
  await setOpeningBalance(db, companyId, cash, toMinor('50000'), user);

  const party = (p: Parameters<typeof createParty>[2]) => createParty(db, companyId, p, user);
  const rajesh = await party({ name: 'Rajesh Traders', kind: 'CUSTOMER', gstin: makeGstin('27', 'AAJFR1234M'), city: 'Pune', creditDays: 30, openingBalance: '45000' });
  const rakesh = await party({ name: 'Rakesh Traders', kind: 'CUSTOMER', gstin: makeGstin('27', 'AAJFR9876Q'), city: 'Nashik', creditDays: 30 });
  const abc = await party({ name: 'ABC Corp', kind: 'CUSTOMER', gstin: makeGstin('29', 'AABCA5555P'), city: 'Bengaluru', creditDays: 45 });
  const mehta = await party({ name: 'Mehta Constructions', kind: 'CUSTOMER', gstin: makeGstin('27', 'AAFCM2468H'), city: 'Mumbai', creditDays: 15 });
  const balaji = await party({ name: 'Shree Balaji Cement Agency', kind: 'SUPPLIER', gstin: makeGstin('27', 'AAPFB1234C'), city: 'Pune', creditDays: 30, openingBalance: '80000' });
  const tata = await party({ name: 'Gujarat Steel Distributors', kind: 'SUPPLIER', gstin: makeGstin('24', 'AAGCG7777L'), city: 'Ahmedabad', creditDays: 30 });
  await party({ name: 'Pune Electricals', kind: 'SUPPLIER', gstin: makeGstin('27', 'AAPFP3333D'), city: 'Pune', creditDays: 15 });
  void rakesh;

  const uom = async (symbol: string) => (await one<{ id: string }>(db, `SELECT id FROM uoms WHERE company_id = $1 AND symbol = $2`, [companyId, symbol])).id;
  const cement = (await createItem(db, companyId, { name: 'Cement OPC 53 Grade', uomId: await uom('Bag'), hsnSac: '2523', gstRate: '18', aliases: ['cement', 'opc cement'] }, user)).id;
  const tmt = (await createItem(db, companyId, { name: 'TMT Steel Bar 12mm', uomId: await uom('Kg'), hsnSac: '7214', gstRate: '18', valuation: 'FIFO', aliases: ['tmt', 'steel', 'saria'] }, user)).id;
  const putty = (await createItem(db, companyId, { name: 'Wall Putty 40kg', uomId: await uom('Bag'), hsnSac: '3214', gstRate: '18', aliases: ['putty'] }, user)).id;
  await createItem(db, companyId, { name: 'PVC Pipe 4 inch', uomId: await uom('Nos'), hsnSac: '3917', gstRate: '18', aliases: ['pipe', 'pvc pipe'] }, user);

  let n = 0;
  const post = (input: Record<string, unknown>) =>
    postVoucher(db, companyId, input, { source: 'SYSTEM', idempotencyKey: `demo:${++n}`, userId: user });
  const line = (itemId: string, qty: string, rate: string) =>
    ({ itemId, qty, rate, amount: (Number(qty) * Number(rate)).toFixed(2), gstRate: '18' });

  await post({ voucherType: 'PURCHASE', date: d(85), counterpartyId: tata.id, partyRefNo: 'GSD/1187', partyRefDate: d(86), items: [line(tmt, '3000', '58')] });
  await post({ voucherType: 'SALES', date: d(75), counterpartyId: abc.id, items: [line(tmt, '1200', '68')] });
  await post({ voucherType: 'PURCHASE', date: d(40), counterpartyId: balaji.id, partyRefNo: 'SBC/0412', partyRefDate: d(41), items: [line(cement, '200', '340')] });
  await post({ voucherType: 'PURCHASE', date: d(30), counterpartyId: balaji.id, partyRefNo: 'SBC/0450', partyRefDate: d(30), items: [line(putty, '100', '420')] });
  await post({ voucherType: 'SALES', date: d(28), counterpartyId: rajesh.id, items: [line(cement, '50', '410')] });
  await post({ voucherType: 'SALES', date: d(25), counterpartyId: abc.id, items: [line(tmt, '800', '68')] });
  await post({ voucherType: 'SALES', date: d(20), counterpartyId: mehta.id, items: [line(putty, '30', '520'), line(cement, '40', '405')] });
  await post({ voucherType: 'RECEIPT', date: d(15), entries: [
    { ledgerId: hdfc, side: 'DR', amount: '20000' },
    { ledgerId: rajesh.ledgerId, side: 'CR', amount: '20000', billRef: 'Opening' },
  ], narration: 'NEFT from Rajesh Traders' });
  await post({ voucherType: 'PAYMENT', date: d(12), entries: [
    { ledgerId: balaji.ledgerId, side: 'DR', amount: '50000', billRef: 'SBC/0412' },
    { ledgerId: hdfc, side: 'CR', amount: '50000' },
  ], narration: 'Part payment, cheque 004512' });
  await post({ voucherType: 'SALES', date: d(10), paymentMode: 'CASH', pricesIncludeTax: true, items: [line(cement, '10', '415')], narration: 'Counter sale' });
  await post({ voucherType: 'PAYMENT', date: d(5), entries: [
    { ledgerId: rent, side: 'DR', amount: '25000' },
    { ledgerId: hdfc, side: 'CR', amount: '25000' },
  ], narration: 'Shop rent' });
  await post({ voucherType: 'PAYMENT', date: d(3), entries: [
    { ledgerId: electricity, side: 'DR', amount: '3200' },
    { ledgerId: cash, side: 'CR', amount: '3200' },
  ], narration: 'MSEDCL bill' });
  await post({ voucherType: 'CONTRA', date: d(2), entries: [
    { ledgerId: hdfc, side: 'DR', amount: '30000' },
    { ledgerId: cash, side: 'CR', amount: '30000' },
  ], narration: 'Cash deposited' });
  return companyId;
}
