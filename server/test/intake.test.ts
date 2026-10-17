import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';
import type { PGlite } from '@electric-sql/pglite';

// The model is simulated: tests drive structured outputs by which system prompt is used.
const modelReply = vi.fn<(system: string, req: unknown) => unknown>();
const reply = (obj: unknown) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(obj) }] });
vi.mock('../src/ai/anthropic', async (orig) => {
  const real = await orig<typeof import('../src/ai/anthropic')>();
  const sysOf = (req: { system: { text: string }[] }) => req.system[0].text;
  return {
    ...real,
    claude: () => ({
      beta: {
        messages: {
          create: async (req: { system: { text: string }[] }) => reply(modelReply(sysOf(req), req)),
          stream: (req: { system: { text: string }[] }) => ({ finalMessage: async () => reply(modelReply(sysOf(req), req)) }),
        },
      },
    }),
  };
});

import { config } from '../src/config';
import { openDb, one, many } from '../src/db/client';
import { seedDemo } from '../src/db/demo';
import { addDays, todayIST } from '../src/lib/dates';
import { makeGstin } from '../src/lib/gstin';
import { parseAmount, parseDate } from '../src/lib/parse';
import { parseCsv, readSheets } from '../src/ai/intake/files';
import { parseStatementSheet } from '../src/ai/intake/statement';
import { narrationPattern } from '../src/ai/intake/bank';
import { deleteDocument, documentFilePath, ingestDocument } from '../src/ai/documents';
import { listEntries, postEntry, postReady, updateEntry } from '../src/ai/intake/entries';
import { createLedger, groupByCode } from '../src/ledger/masters';
import { reverseVoucher, verifyChain } from '../src/ledger/post';
import { trialBalance } from '../src/reports/financials';

let db: PGlite;
let companyId: string;
const user = config.localUserId;
const today = todayIST();
const d = (n: number) => addDays(today, -n);
const dmy = (iso: string) => iso.split('-').reverse().join('/');

beforeAll(async () => {
  config.uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kannaku-uploads-'));
  db = await openDb();
  companyId = await seedDemo(db);
}, 60_000);

/** Upload a file and wait for the background pipeline to finish with it. */
async function upload(name: string, mime: string, data: Buffer, options = {}) {
  const doc = await ingestDocument(db, companyId, { name, mime, data }, user, options);
  for (let i = 0; i < 200; i++) {
    const r = await one<{ status: string; error: string | null }>(db, `SELECT status, error FROM documents WHERE id = $1`, [doc.id]);
    if (!['RECEIVED', 'PROCESSING'].includes(r.status)) return { id: doc.id, ...r };
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error('document did not finish processing');
}
type Entry = { id: string; lineNo: number; status: string; payload: any; suggestion: any; issues: any[]; source: any };
const entries = async (docId: string) => (await listEntries(db, companyId, docId)) as Entry[];
const ledgerId = async (name: string) => (await one<{ id: string }>(db, `SELECT id FROM ledgers WHERE company_id = $1 AND name = $2`, [companyId, name])).id;

describe('parsing helpers', () => {
  it('reads Indian dates and amounts', () => {
    expect(parseDate('03/04/2026')).toBe('2026-04-03');
    expect(parseDate('03-Apr-26')).toBe('2026-04-03');
    expect(parseDate('31/02/2026')).toBeNull();
    expect(parseDate(46115)).toBe('2026-04-03');                 // Excel serial
    expect(parseAmount('1,23,456.50')?.toString()).toBe('123456.5');
    expect(parseAmount('(250.00)')?.toString()).toBe('-250');
    expect(parseAmount('500.00 Dr')?.toString()).toBe('-500');
    expect(parseAmount('-')).toBeNull();
  });
  it('parses quoted CSV with semicolons', () => {
    expect(parseCsv('a;"b; c";d\n1;"say ""hi""";3')).toEqual([['a', 'b; c', 'd'], ['1', 'say "hi"', '3']]);
  });
  it('keeps only the meaningful part of a narration for learning', () => {
    expect(narrationPattern('UPI/412345678901/RAJESH TRADERS/rajesh@okhdfc/Payment')).toBe('rajesh traders');
  });
  it('prefers the transaction date over a value date, and reads amount + Dr/Cr statements', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Statement');
    ws.addRow(['ICICI Bank', null, 'A/c No: 000401234567']);
    ws.addRow([]);
    ws.addRow(['S No.', 'Value Date', 'Transaction Date', 'Transaction Remarks', 'Withdrawal Amount (INR )', 'Deposit Amount (INR )', 'Balance (INR )']);
    ws.addRow([1, '02/09/2026', '01/09/2026', 'NEFT-ABC CORP', null, 1000, 6000]);
    ws.addRow([2, '05/09/2026', '05/09/2026', 'BIL/ONL/AIRTEL', 200, null, 5800]);
    const [sheet] = await readSheets(Buffer.from(await wb.xlsx.writeBuffer()), 'sheet');
    const st = parseStatementSheet(sheet)!;
    expect(st.lines.map((l) => [l.date, String(l.creditMinor), String(l.debitMinor)])).toEqual([['2026-09-01', '100000', '0'], ['2026-09-05', '0', '20000']]);
    expect(st).toMatchObject({ bankName: 'ICICI Bank', accountHint: '4567', openingMinor: 500000n, closingMinor: 580000n, issues: [] });

    const [drcr] = await readSheets(Buffer.from('Date,Description,Amount,Dr/Cr,Balance\n01/09/2026,SALARY SEPT,"50,000.00",Dr,10000\n02/09/2026,INT CREDIT,15,Cr,9015\n'), 'csv');
    const st2 = parseStatementSheet(drcr)!;
    expect(st2.lines.map((l) => [String(l.debitMinor), String(l.creditMinor)])).toEqual([['5000000', '0'], ['0', '1500']]);
    expect(st2.issues.map((i) => i.code)).toContain('BALANCE_BREAK');   // 10000 + 15 is not 9015
  });
});

// A statement for the demo company's HDFC account. Four lines are already in the books (demo vouchers).
function hdfcStatementCsv(extra: [number, string, number, number][] = []) {
  const rows: [number, string, number, number][] = [
    [15, 'NEFT CR-HDFC0001234-RAJESH TRADERS-PART PAYMENT', 0, 20000],     // in books: receipt
    [12, 'CHQ PAID-004512-SHREE BALAJI CEMENT AGENCY', 50000, 0],          // in books: payment
    [8, 'UPI/412345678901/RAJESH TRADERS/rajesh@okhdfc/Payment', 0, 25000], // party + open bill "Opening"
    [7, 'ATM WDL/CHENNAI ANNA NAGAR', 5000, 0],                              // cash withdrawal -> contra
    [6, 'SMS CHRG FOR QTR SEP', 17.7, 0],                                    // bank charges
    [5, 'RENT SEPT - SHOP', 25000, 0],                                       // in books: rent payment
    [4, 'NEFT/MEHTA CONSTRUCTIONS/INV 4', 0, 37524],                         // party + bill 4 (demo sales voucher 4)
    [3, 'UPI/9988776655/XYZ NETWORKS/xyz@ybl/Pay', 1234, 0],                 // unknown
    [2, 'CASH DEP-ANNA NAGAR BRANCH', 0, 30000],                             // in books: contra
    [1, 'SB INT PD UPTO 30-SEP', 0, 150],                                    // interest
    ...extra,
  ];
  let bal = 100000;
  const lines = rows.map(([ago, narr, wd, dep]) => {
    bal = Math.round((bal - wd + dep) * 100) / 100;
    return `${dmy(d(ago))},"${narr}",REF${ago},${dmy(d(ago))},${wd || ''},${dep || ''},${bal.toFixed(2)}`;
  });
  return Buffer.from(['HDFC BANK LTD', 'Account No : XXXXXXXX4321', '', 'Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance', ...lines, ''].join('\n'));
}

describe('bank statement (CSV, no AI)', () => {
  let docId = '';

  it('recognises what is already in the books and proposes the rest', async () => {
    const r = await upload('hdfc-sept.csv', 'text/csv', hdfcStatementCsv());
    expect(r).toMatchObject({ status: 'NEEDS_REVIEW', error: null });
    docId = r.id;
    const doc = await one<{ doc_type: string; summary: any }>(db, `SELECT doc_type, summary FROM documents WHERE id = $1`, [docId]);
    expect(doc.doc_type).toBe('BANK_STATEMENT');
    expect(doc.summary).toMatchObject({ bankLedgerName: 'HDFC Bank', accountHint: '4321', createdBankLedger: false });

    const es = await entries(docId);
    const by = (n: number) => es.find((e) => e.lineNo === n)!;
    expect([1, 2, 6, 9].map((n) => by(n).status)).toEqual(['IN_BOOKS', 'IN_BOOKS', 'IN_BOOKS', 'IN_BOOKS']);
    expect(by(3)).toMatchObject({ status: 'READY', suggestion: { how: 'party', counterName: 'Rajesh Traders' } });
    expect(by(3).payload.entries[1]).toMatchObject({ side: 'CR', amount: '25000.00', billRef: 'Opening' });
    expect(by(4)).toMatchObject({ status: 'READY', payload: { voucherType: 'CONTRA' }, suggestion: { counterName: 'Cash' } });
    expect(by(5)).toMatchObject({ status: 'READY', suggestion: { how: 'rule', counterName: 'Bank Charges' } });  // ledger created on the fly
    expect(by(7).payload.entries[1]).toMatchObject({ billRef: '4' });
    expect(by(8)).toMatchObject({ status: 'NEEDS_INPUT', payload: null });
    expect(by(10)).toMatchObject({ status: 'READY', suggestion: { counterName: 'Bank Interest' } });
  });

  it('posts every ready line in one go, then the one a person decides', async () => {
    const res = await postReady(db, companyId, docId, user);
    expect(res).toEqual({ posted: 5, failed: [] });
    const unknown = (await entries(docId)).find((e) => e.lineNo === 8)!;
    const phone = await ledgerId('Telephone & Internet');
    const bank = await ledgerId('HDFC Bank');
    const upd = await updateEntry(db, companyId, docId, unknown.id, {
      voucherType: 'PAYMENT', date: d(3), narration: unknown.source.narration,
      entries: [{ ledgerId: phone, side: 'DR', amount: '1234.00' }, { ledgerId: bank, side: 'CR', amount: '1234.00' }],
    });
    expect(upd.status).toBe('READY');
    await postEntry(db, companyId, docId, unknown.id, user);
    const doc = await one<{ status: string }>(db, `SELECT status FROM documents WHERE id = $1`, [docId]);
    expect(doc.status).toBe('ACCEPTED');                       // nothing left to decide
    expect((await verifyChain(db, companyId)).ok).toBe(true);
    const tb = await trialBalance(db, companyId, today);
    expect(tb.totalDebitMinor).toBe(tb.totalCreditMinor);
  });

  it('never posts a line twice when an overlapping statement is uploaded, and remembers the reviewer\'s choice', async () => {
    const r = await upload('hdfc-sept-again.csv', 'text/csv', hdfcStatementCsv([[0, 'UPI/1122334455/XYZ NETWORKS/xyz@ybl/Pay', 999, 0]]));
    const es = await entries(r.id);
    expect(es.filter((e) => e.lineNo <= 10).every((e) => e.status === 'IN_BOOKS')).toBe(true);
    expect(es.find((e) => e.lineNo === 11)).toMatchObject({ status: 'READY', suggestion: { how: 'learned', counterName: 'Telephone & Internet' } });
  });

  it('refuses old .xls files with a clear message', async () => {
    await expect(ingestDocument(db, companyId, { name: 'old.xls', mime: 'application/vnd.ms-excel', data: Buffer.from('x') }, user)).rejects.toMatchObject({ code: 'OLD_EXCEL' });
  });
});

describe('workings and registers (Excel/CSV, no AI)', () => {
  it('turns a journal working into entries, asking for ledgers that do not exist yet', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Year-end JVs');
    ws.addRow(['Adjustments for September']);
    ws.addRow(['JV No', 'Date', 'Ledger', 'Debit', 'Credit', 'Narration']);
    ws.addRow(['JV1', dmy(d(1)), 'Depreciation', 12000, null, 'Depreciation on furniture']);
    ws.addRow(['JV1', null, 'Furniture & Fixtures', null, 12000, null]);
    ws.addRow(['JV2', dmy(d(1)), 'Electricity', 4500, null, 'Provision for September electricity']);
    ws.addRow(['JV2', null, 'Outstanding Expenses', null, 4500, null]);
    const r = await upload('jv.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', Buffer.from(await wb.xlsx.writeBuffer()));
    expect(r.status).toBe('NEEDS_REVIEW');
    const es = await entries(r.id);
    expect(es).toHaveLength(2);
    expect(es[0]).toMatchObject({ status: 'NEEDS_INPUT', payload: null });
    expect(es[0].suggestion.unmatched.map((u: { account: string }) => u.account)).toEqual(['Depreciation', 'Furniture & Fixtures']);
    expect(es[1].suggestion.unmatched.map((u: { account: string }) => u.account)).toEqual(['Outstanding Expenses']);

    // The reviewer creates the missing ledgers; the entries then go through.
    const g = async (code: string) => (await groupByCode(db, companyId, code)).id;
    const dep = (await createLedger(db, companyId, { name: 'Depreciation', groupId: await g('INDIRECT_EXPENSES') }, user)).id;
    const furn = (await createLedger(db, companyId, { name: 'Furniture & Fixtures', groupId: await g('FIXED_ASSETS') }, user)).id;
    const upd = await updateEntry(db, companyId, r.id, es[0].id, {
      voucherType: 'JOURNAL', date: d(1), narration: 'Depreciation on furniture',
      entries: [{ ledgerId: dep, side: 'DR', amount: '12000' }, { ledgerId: furn, side: 'CR', amount: '12000' }],
    });
    expect(upd.status).toBe('READY');
    const posted = await postEntry(db, companyId, r.id, es[0].id, user);
    expect(posted.voucherType).toBe('JOURNAL');
  });

  const registerCsv = (extraLine = '') => Buffer.from([
    'Sales Register September',
    'Invoice No,Invoice Date,Customer Name,GSTIN,Taxable Value,CGST,SGST,IGST,Invoice Value',
    `INV-101,${dmy(d(2))},Rajesh Traders,${makeGstin('27', 'AAJFR1234M')},10000,900,900,,11800`,
    `INV-102,${dmy(d(1))},Kumar Stores,${makeGstin('33', 'AAKFK1111Q')},5000,,,900,5900`,
    'Total,,,,15000,900,900,900,17700',
    extraLine,
  ].join('\n'));

  it('books a sales register, creating the customer that is new, and spots it on re-upload', async () => {
    const r = await upload('sales-register.csv', 'text/csv', registerCsv());
    const es = await entries(r.id);
    expect(es.map((e) => e.status)).toEqual(['READY', 'READY']);
    expect(es[1].suggestion.newParty).toMatchObject({ name: 'Kumar Stores', kind: 'CUSTOMER' });
    expect(await postReady(db, companyId, r.id, user)).toEqual({ posted: 2, failed: [] });
    const kumar = await one<{ state_code: string }>(db, `SELECT state_code FROM counterparties WHERE legal_name = 'Kumar Stores'`);
    expect(kumar.state_code).toBe('33');
    const igst = await many(db, `SELECT 1 FROM voucher_tax_lines t JOIN vouchers v ON v.id = t.voucher_id WHERE v.party_ref_no = 'INV-102' AND t.component = 'IGST'`);
    expect(igst).toHaveLength(1);                                   // Tamil Nadu customer: inter-state

    const again = await upload('sales-register-2.csv', 'text/csv', registerCsv('\n'));
    expect((await entries(again.id)).map((e) => e.status)).toEqual(['IN_BOOKS', 'IN_BOOKS']);
  });

  it('auto-posts confident entries when switched on', async () => {
    await db.query(`UPDATE companies SET auto_post = true, auto_post_limit_minor = 10000000 WHERE id = $1`, [companyId]);
    const csv = Buffer.from(['Purchase Register', 'Bill No,Bill Date,Supplier Name,GSTIN,Taxable Value,CGST,SGST,Total',
      `SBC/0999,${dmy(d(1))},Shree Balaji Cement Agency,${makeGstin('27', 'AAPFB1234C')},1000,90,90,1180`].join('\n'));
    const r = await upload('purchase-register.csv', 'text/csv', csv);
    expect(r.status).toBe('ACCEPTED');
    expect((await entries(r.id))[0].status).toBe('POSTED');
    await db.query(`UPDATE companies SET auto_post = false WHERE id = $1`, [companyId]);
  });
});

describe('PDFs and photos (model simulated)', () => {
  it('reads a PDF bank statement and lets the model place leftover lines, only from real accounts', async () => {
    config.aiEnabled = true;
    modelReply.mockImplementation((system: string, req: any) => {
      if (system.startsWith('You sort financial documents')) return { doc_type: 'BANK_STATEMENT', issuer_name: 'HDFC Bank', issuer_gstin: null, reason: 'statement' };
      if (system.startsWith('You transcribe Indian bank statements')) {
        return { bank_name: 'HDFC Bank', account_number: 'XXXX4321', opening_balance: '1000.00', closing_balance: '500.00', warnings: [],
          transactions: [{ date: d(0), narration: 'POS/SWIGGY/BANGALORE', reference: null, withdrawal: '500.00', deposit: null, balance: '500.00' }] };
      }
      if (system.startsWith('You match bank statement lines')) {
        const text: string = req.messages[0].content[0].text;
        const key = /(a\d+): Salaries/.exec(text)![1];
        return { decisions: [{ line_no: 1, counter_key: key, bill_ref: null, confidence: 'high', reason: 'staff lunch' }, { line_no: 1, counter_key: 'a9999', bill_ref: null, confidence: 'high', reason: 'invented' }] };
      }
      throw new Error(`unexpected prompt: ${system.slice(0, 40)}`);
    });
    const r = await upload('statement.pdf', 'application/pdf', Buffer.from('%PDF-1.4 fake'));
    expect(r).toMatchObject({ status: 'NEEDS_REVIEW', error: null });
    const [e] = await entries(r.id);
    expect(e).toMatchObject({ status: 'READY', suggestion: { how: 'ai', counterName: 'Salaries' } });
    config.aiEnabled = false;
  });

  it('recognises an invoice we issued and books it as a sale to the customer', async () => {
    config.aiEnabled = true;
    const co = await one<{ gstin: string }>(db, `SELECT gstin FROM companies WHERE id = $1`, [companyId]);
    const ev = (value: string | null) => ({ value, raw: value, page: 1 });
    modelReply.mockImplementation((system: string) => {
      if (system.startsWith('You sort financial documents')) return { doc_type: 'PURCHASE_BILL', issuer_name: 'Sharma Building Supplies', issuer_gstin: co.gstin, reason: 'tax invoice' };
      return {
        document_type: 'TAX_INVOICE',
        supplier: { name: ev('Sharma Building Supplies'), gstin: ev(co.gstin), address: null, state: 'Maharashtra', phone: null },
        buyer: { name: ev('Mehta Constructions'), gstin: ev(makeGstin('27', 'AAFCM2468H')), address: null, state: 'Maharashtra', phone: null },
        invoice_number: ev('SBS/77'), invoice_date: ev(d(1)), due_date: null, place_of_supply: 'Maharashtra', reverse_charge: false,
        irn: null, original_invoice_ref: null, currency: 'INR',
        line_items: [{ line_no: 1, description: 'Wall Putty 40kg', hsn_sac: '3214', quantity: '2', uom: 'BAG', unit_price: '500.00', discount: null,
          taxable_value: '1000.00', gst_rate_percent: '18', cgst: '90.00', sgst: '90.00', igst: null, cess: null, line_total: '1180.00' }],
        charges: [], tax_summary: [],
        totals: { subtotal: '1000.00', discount_total: null, tax_total: '180.00', round_off: null, grand_total: ev('1180.00'), amount_in_words: null },
        payment: { status: 'UNPAID', mode: null, amount_paid: null, reference: null }, warnings: [],
      };
    });
    const r = await upload('our-invoice.jpg', 'image/jpeg', Buffer.from('fake jpeg'));
    expect(r).toMatchObject({ status: 'NEEDS_REVIEW', error: null });
    const doc = await one<{ doc_type: string; draft: any; matches: any; validation: any[] }>(db,
      `SELECT d.doc_type, vd.payload AS draft, d.matches, d.validation FROM documents d JOIN voucher_drafts vd ON vd.id = d.draft_id WHERE d.id = $1`, [r.id]);
    expect(doc.doc_type).toBe('SALES_INVOICE');                      // corrected by our own GSTIN on the document
    expect(doc.draft).toMatchObject({ voucherType: 'SALES', partyRefNo: 'SBS/77' });
    expect(doc.matches).toMatchObject({ partyRole: 'customer', party: { status: 'MATCHED', match: { name: 'Mehta Constructions' } } });
    expect(doc.matches.recomputedTotal).toBe('1180.00');
    expect(doc.validation.filter((i) => i.severity === 'error')).toEqual([]);
    config.aiEnabled = false;
  });

  it('explains that PDFs need the AI when it is off', async () => {
    const r = await upload('scan.pdf', 'application/pdf', Buffer.from('%PDF-1.4 another'));
    expect(r.status).toBe('FAILED');
    expect(r.error).toMatch(/needs the AI/);
  });
});

describe('deleting documents', () => {
  it('removes a document that was never posted, with its file, so it can be uploaded again', async () => {
    config.aiEnabled = false;
    const data = Buffer.from('%PDF-1.4 delete me');
    const r = await upload('wrong.pdf', 'application/pdf', data);
    expect(r.status).toBe('FAILED');
    const { storage_key } = await one<{ storage_key: string }>(db, `SELECT storage_key FROM documents WHERE id = $1`, [r.id]);
    expect(fs.existsSync(documentFilePath(storage_key))).toBe(true);

    await deleteDocument(db, companyId, r.id, user);
    expect(await many(db, `SELECT 1 FROM documents WHERE id = $1`, [r.id])).toHaveLength(0);
    expect(fs.existsSync(documentFilePath(storage_key))).toBe(false);
    expect((await upload('wrong.pdf', 'application/pdf', data)).status).toBe('FAILED');  // no "already uploaded"
  });

  it('refuses while entries from it are in the books, and allows it once they are reversed', async () => {
    const { document_id: docId } = await one<{ document_id: string }>(db,
      `SELECT document_id FROM document_entries WHERE company_id = $1 AND status = 'POSTED' LIMIT 1`, [companyId]);
    await expect(deleteDocument(db, companyId, docId, user)).rejects.toThrow(/Reverse them from the Day Book/);

    const posted = await many<{ voucher_id: string }>(db, `SELECT voucher_id FROM document_entries WHERE document_id = $1 AND voucher_id IS NOT NULL`, [docId]);
    for (const p of posted) await reverseVoucher(db, companyId, p.voucher_id, { userId: user, source: 'MANUAL' });
    await deleteDocument(db, companyId, docId, user);
    expect(await many(db, `SELECT 1 FROM document_entries WHERE document_id = $1`, [docId])).toHaveLength(0);
    expect(await many(db, `SELECT 1 FROM vouchers WHERE id = ANY($1)`, [posted.map((p) => p.voucher_id)])).toHaveLength(posted.length);  // the books keep them
    expect((await verifyChain(db, companyId)).ok).toBe(true);
  });
});
