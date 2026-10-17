import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';

// Claude is mocked: these tests cover everything around the model call.
const createMock = vi.fn();
vi.mock('../src/ai/anthropic', async (orig) => {
  const real = await orig<typeof import('../src/ai/anthropic')>();
  return { ...real, claude: () => ({ beta: { messages: { create: createMock } } }) };
});

import { openDb, one } from '../src/db/client';
import { config } from '../src/config';
import { seedDemo } from '../src/db/demo';
import { normalizeTranscript, wordsToNumber } from '../src/ai/voice/normalize';
import { groundRecordVoucher } from '../src/ai/voice/grounding';
import { confirmSession, handleUtterance, isCancel, isConfirm } from '../src/ai/voice/engine';
import { buildReview, acceptDocument } from '../src/ai/documents';
import { dec, lineTaxable } from '../src/ai/bill-numbers';
import { postVoucher } from '../src/ledger/post';
import { LedgerContext } from '../src/ledger/context';
import { makeGstin } from '../src/lib/gstin';
import { todayIST, addDays } from '../src/lib/dates';
import type { ParsedBill } from '../src/ai/bill-schema';
import type { RecordVoucherCall } from '../src/ai/voice/tools';

describe('number normaliser', () => {
  const cases: [string, number[]][] = [
    ['record a cash sale of 5,500 rupees', [5500]],
    ['pachpan sau rupaye', [5500]],
    ['dedh lakh ka maal', [150000]],
    ['saade teen hazaar', [3500]],
    ['paune do sau', [175]],
    ['five thousand five hundred', [5500]],
    ['one lakh fifty thousand', [150000]],
    ['2.5 lakh', [250000]],
    ['5.5k', [5500]],
    ['10 bags of cement including 18% GST', [10, 18]],
    ['do bag cement', [2]],
    ['what do you have', []],
    ['twenty five point five', [25.5]],
  ];
  for (const [input, values] of cases) {
    it(`"${input}"`, () => expect(normalizeTranscript(input).spans.map((s) => s.value)).toEqual(values));
  }
  it('reads amount in words with paise', () => {
    expect(wordsToNumber('Forty Thousand Seven Hundred Ten Only')).toBe(40710);
    expect(wordsToNumber('Rupees One Lakh Twenty-Three Thousand and Fifty Paise Only')).toBe(123000.5);
  });
});

describe('grounding', () => {
  const base: RecordVoucherCall = {
    voucher_type: 'SALES', date: null, party: { candidate_id: 'p1', spoken: 'Rajesh Traders' }, payment_mode: 'CASH',
    items: [{ entity: { candidate_id: 'i1', spoken: 'cement' }, quantity: { value: '10', spoken: '10 bags' }, unit: 'bag', rate: null }],
    other_ledger: null, amount: { value: '5500', spoken: '5500 rupees' }, amount_includes_tax: true, gst_rate_percent: '18', narration: null, missing: [],
  };
  const heard = normalizeTranscript('Record a cash sale of 5,500 rupees to Rajesh Traders for 10 bags of cement including 18% GST').text;
  it('accepts numbers that were said', () => expect(groundRecordVoucher(base, heard)).toEqual([]));
  it('rejects a made-up amount', () => {
    const p = groundRecordVoucher({ ...base, amount: { value: '5000', spoken: '5500 rupees' } }, heard);
    expect(p[0].path).toBe('amount');
  });
  it('rejects citations that were never heard', () => {
    expect(groundRecordVoucher({ ...base, amount: { value: '6500', spoken: '6500 rupees' } }, heard)).toHaveLength(1);
    expect(groundRecordVoucher({ ...base, gst_rate_percent: '12' }, heard)[0].path).toBe('gst_rate_percent');
  });
});

describe('numbers written by the model', () => {
  it('reads grouped, unit-suffixed and percent values instead of failing the document', () => {
    expect(dec('1,250.00')?.toString()).toBe('1250');
    expect(dec('₹ 500')?.toString()).toBe('500');
    expect(dec('10 Nos')?.toString()).toBe('10');
    expect(dec('18%')?.toString()).toBe('18');
    expect(dec('n/a')).toBeNull();
    expect(dec(null)).toBeNull();
  });
  it('works out a taxable value from a line that prints only its total', () => {
    const line = { description: 'Cement', hsn_sac: null, quantity: null, unit: null, unit_price: null, discount: null, taxable_value: null,
      gst_rate_percent: '18', cgst: '90.00', sgst: '90.00', igst: null, cess: null, line_total: '1,180.00' } as unknown as ParsedBill['line_items'][number];
    expect(lineTaxable(line)?.toString()).toBe('1000');
  });
});

describe('confirm grammar', () => {
  it('matches fixed phrases only', () => {
    expect(isConfirm('Haan post karo')).toBe(true);
    expect(isConfirm('confirm')).toBe(true);
    expect(isConfirm('confirm the sale to Rakesh')).toBe(false);
    expect(isCancel('nahi')).toBe(true);
  });
});

let db: PGlite;
let companyId: string;
beforeAll(async () => {
  db = await openDb();
  companyId = await seedDemo(db);
}, 60_000);

const toolUse = (name: string, input: unknown) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name, input }] });

describe('voice engine (model mocked)', () => {
  it('drafts, reads back and posts the spec example on "haan"', async () => {
    createMock.mockImplementationOnce(async (req: { messages: { content: string }[] }) => {
      const ctx = req.messages[0].content;
      const p = /(p\d+): party "Rajesh Traders"/.exec(ctx)![1];
      const i = /(i\d+): item "Cement OPC 53 Grade"/.exec(ctx)![1];
      return toolUse('record_voucher', {
        voucher_type: 'SALES', date: null, party: { candidate_id: p, spoken: 'Rajesh Traders' }, payment_mode: 'CASH',
        items: [{ entity: { candidate_id: i, spoken: 'cement' }, quantity: { value: '10', spoken: '10 bags' }, unit: 'bag', rate: null }],
        other_ledger: null, amount: { value: '5500', spoken: '5500 rupees' }, amount_includes_tax: true, gst_rate_percent: '18', narration: null, missing: [],
      });
    });
    const r = await handleUtterance(db, companyId, { transcript: 'Record a cash sale of 5,500 rupees to Rajesh Traders for 10 bags of cement including 18% GST', confidence: 0.93 });
    expect(r.kind).toBe('voucher');
    expect(r.speech).toContain('Cash sale to Rajesh Traders');
    expect(r.speech).toContain('Total 5,500 rupees, including GST of 838 rupees 98 paise');
    const posted = await handleUtterance(db, companyId, { transcript: 'haan', sessionId: r.sessionId });
    expect(posted.kind).toBe('posted');
    expect(createMock).toHaveBeenCalledTimes(1); // confirmation never reached the model
    // Replaying the confirmation cannot double-post.
    await expect(confirmSession(db, companyId, r.sessionId!, 'voice')).rejects.toMatchObject({ code: 'NOTHING_TO_CONFIRM' });
  });

  it('asks instead of guessing when the model cites words that were not said', async () => {
    createMock.mockImplementationOnce(async () => toolUse('record_voucher', {
      voucher_type: 'PAYMENT', date: null, party: null, payment_mode: 'CASH', items: [], other_ledger: null,
      amount: { value: '3000', spoken: '3000' }, amount_includes_tax: null, gst_rate_percent: null, narration: null, missing: [],
    }));
    const r = await handleUtterance(db, companyId, { transcript: 'paid the electricity bill in cash' });
    expect(r).toMatchObject({ kind: 'clarify', speech: 'Sorry, what was the amount?' });
  });

  it('requires the screen for amounts above the voice limit', async () => {
    createMock.mockImplementationOnce(async (req: { messages: { content: string }[] }) => {
      const ctx = req.messages[0].content;
      const rent = /(l\d+): ledger "Rent"/.exec(ctx)![1];
      return toolUse('record_voucher', {
        voucher_type: 'PAYMENT', date: null, party: null, payment_mode: 'BANK', items: [], other_ledger: { candidate_id: rent, spoken: 'rent' },
        amount: { value: '200000', spoken: '2 lakh' }, amount_includes_tax: null, gst_rate_percent: null, narration: null, missing: [],
      });
    });
    const r = await handleUtterance(db, companyId, { transcript: 'paid 2 lakh rent from bank' });
    expect(r.kind).toBe('voucher');
    expect(r.speech).toContain('above your voice limit');
    await expect(confirmSession(db, companyId, r.sessionId!, 'voice')).rejects.toMatchObject({ code: 'NEEDS_SCREEN_CONFIRM' });
    const ok = await confirmSession(db, companyId, r.sessionId!, 'screen');
    expect(ok.kind).toBe('posted');
  });

  it('reverses a voucher above the voice limit only from the screen', async () => {
    const sale = await postVoucher(db, companyId, {
      voucherType: 'SALES', date: todayIST(), paymentMode: 'CASH', items: [{ amount: '250000', gstRate: '0', description: 'Bulk order' }],
    }, { source: 'MANUAL', idempotencyKey: 'voice-reverse-big', userId: config.localUserId });
    createMock.mockImplementationOnce(async () => toolUse('reverse_voucher', { voucher_type: 'SALES', voucher_no: sale.voucherNo }));
    const r = await handleUtterance(db, companyId, { transcript: `reverse sale ${sale.voucherNo}` });
    expect(r.kind).toBe('reverse');
    await expect(confirmSession(db, companyId, r.sessionId!, 'voice')).rejects.toMatchObject({ code: 'NEEDS_SCREEN_CONFIRM' });
    expect((await confirmSession(db, companyId, r.sessionId!, 'screen')).kind).toBe('posted');
  });
});

describe('bill review (extraction mocked)', () => {
  const ev = (value: string | null) => ({ value, raw: value, page: 1 });
  const bill = (over: Partial<ParsedBill> = {}): ParsedBill => ({
    document_type: 'TAX_INVOICE',
    supplier: { name: ev('SHREE BALAJI CEMENT AGENCY'), gstin: ev(makeGstin('27', 'AAPFB1234C')), address: null, state: 'Maharashtra', phone: null },
    buyer: { name: ev('Sharma Building Supplies'), gstin: ev(null), address: null, state: null, phone: null },
    invoice_number: ev('SBC/0777'), invoice_date: ev(addDays(todayIST(), -1)), due_date: null, place_of_supply: '27',
    reverse_charge: false, irn: null, original_invoice_ref: null, currency: 'INR',
    line_items: [{ line_no: 1, description: 'UltraTech OPC 53 Grade Cement 50kg', hsn_sac: '2523', quantity: '100', uom: 'BAG', unit_price: '340.00',
      discount: null, taxable_value: '34000.00', gst_rate_percent: '18', cgst: '3060.00', sgst: '3060.00', igst: null, cess: null, line_total: '40120.00' }],
    charges: [{ label: 'Freight', amount: '500.00', gst_rate_percent: '18', hsn_sac: '9965' }],
    tax_summary: [],
    totals: { subtotal: '34500.00', discount_total: null, tax_total: '6210.00', round_off: '0.00', grand_total: ev('40710.00'), amount_in_words: 'Forty Thousand Seven Hundred Ten Only' },
    payment: { status: 'UNPAID', mode: null, amount_paid: null, reference: null },
    warnings: [],
    ...over,
  });

  it('matches supplier and item, recomputes tax, and posts on accept', async () => {
    const ctx = await LedgerContext.load(db, companyId);
    const review = await buildReview(db, ctx, bill());
    expect(review.matches.party.status).toBe('MATCHED');
    expect(review.matches.lines[0].itemName).toBe('Cement OPC 53 Grade');
    expect(review.matches.lines[1].ledgerName).toBe('Freight Inward');
    expect(review.matches.recomputedTotal).toBe('40710.00');
    expect(review.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(review.issues.map((i) => i.code)).toContain('WORDS_MATCH');

    const doc = await one<{ id: string }>(db,
      `INSERT INTO documents (company_id, sha256, file_name, storage_key, mime, size_bytes, status) VALUES ($1,'x','b.pdf','x','application/pdf',1,'NEEDS_REVIEW') RETURNING id`, [companyId]);
    const posted = await acceptDocument(db, companyId, doc.id, { draft: review.draft }, config.localUserId);
    expect(posted.totalMinor).toBe(4071000n);
    // Second scan of the same bill is flagged as a duplicate.
    const again = await buildReview(db, ctx, bill());
    expect(again.issues.map((i) => i.code)).toContain('DUPLICATE_BILL');
  });

  it('flags arithmetic, tax-split and GSTIN problems', async () => {
    const ctx = await LedgerContext.load(db, companyId);
    const bad = bill({
      supplier: { name: ev('New Hardware Mart'), gstin: ev('27AAPFB1234C1Z0'), address: null, state: 'Maharashtra', phone: null },
      totals: { subtotal: null, discount_total: null, tax_total: '6210.00', round_off: null, grand_total: ev('49999.00'), amount_in_words: null },
      line_items: [{ ...bill().line_items[0], igst: '6120.00', cgst: null, sgst: null }],
    });
    const review = await buildReview(db, ctx, bad);
    const codes = review.issues.map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['GSTIN_INVALID', 'TOTAL_MISMATCH', 'TAX_SPLIT']));
    expect(review.matches.party.status).not.toBe('MATCHED');
  });
});

// ---------------------------------------------------------------- Tamil
import { transliterate } from '../src/lib/tamil';

describe('Tamil numbers', () => {
  const cases: [string, number[]][] = [
    ['ஐயாயிரத்து ஐநூறு ரூபாய்', [5500]],
    ['ஒரு லட்சத்து ஐம்பதாயிரம்', [150000]],
    ['இருபத்தி ஐந்தாயிரம்', [25000]],
    ['அரை லட்சம்', [50000]],
    ['ஒன்றரை லட்சம்', [150000]],
    ['ஐயாயிரத்து ஐநூற்று ஐம்பது', [5550]],
    ['இரண்டு லட்சத்து ஐம்பதாயிரம்', [250000]],
    ['நூற்று ஐம்பது', [150]],
    ['பத்து மூட்டை சிமெண்ட்', [10]],
    ['ஒரு மூட்டை', [1]],
    ['ஒரு விற்பனை பதிவு செய்', []],          // ஒரு as the article "a"
    ['5500 ரூபாய்க்கு', [5500]],
    ['anju aayiram', [5000]],
    ['rendu latcham', [200000]],
    ['the constructor paid', []],             // no Object.prototype lookups
  ];
  for (const [input, values] of cases) {
    it(`"${input}"`, () => expect(normalizeTranscript(input).spans.map((s) => s.value)).toEqual(values));
  }
  it('transliterates Tamil script for name lookup', () => {
    expect(transliterate('ராஜேஷ் டிரேடர்ஸ்')).toBe('rajesh diredars');
  });
});

describe('Tamil confirm grammar and grounding', () => {
  it('accepts Tamil confirmations and cancellations only as whole phrases', () => {
    for (const t of ['சரி', 'ஆமாம்', 'போடு', 'பதிவு செய்', 'sari', 'aama']) expect(isConfirm(t)).toBe(true);
    for (const t of ['வேண்டாம்', 'ரத்து', 'vendam']) expect(isCancel(t)).toBe(true);
    expect(isConfirm('சரி ராகேஷ் டிரேடர்ஸ்-க்கு போடு')).toBe(false);
  });
  it('grounds numbers cited from a Tamil transcript', () => {
    const heard = normalizeTranscript('பத்து மூட்டை சிமெண்ட் ஐயாயிரத்து ஐநூறு ரூபாய் 18% ஜிஎஸ்டி சேர்த்து').text;
    const call: RecordVoucherCall = {
      voucher_type: 'SALES', date: null, party: null, payment_mode: 'CASH',
      items: [{ entity: { candidate_id: 'i1', spoken: 'சிமெண்ட்' }, quantity: { value: '10', spoken: '10 மூட்டை' }, unit: null, rate: null }],
      other_ledger: null, amount: { value: '5500', spoken: '5500 ரூபாய்' }, amount_includes_tax: true, gst_rate_percent: '18', narration: null, missing: [],
    };
    expect(groundRecordVoucher(call, heard)).toEqual([]);
    expect(groundRecordVoucher({ ...call, amount: { value: '5000', spoken: '5500 ரூபாய்' } }, heard)[0].field).toBe('amount');
  });
});

describe('Tamil voice end to end (model mocked)', () => {
  it('records a sale spoken in Tamil, reads it back in Tamil, posts on "சரி"', async () => {
    let context = '';
    createMock.mockImplementationOnce(async (req: { messages: { content: string }[] }) => {
      context = req.messages[0].content;
      const p = /(p\d+): party "Rajesh Traders"/.exec(context)![1];
      const i = /(i\d+): item "Cement OPC 53 Grade"/.exec(context)![1];
      return toolUse('record_voucher', {
        voucher_type: 'SALES', date: null, party: { candidate_id: p, spoken: 'ராஜேஷ் டிரேடர்ஸ்' }, payment_mode: 'CASH',
        items: [{ entity: { candidate_id: i, spoken: 'சிமெண்ட்' }, quantity: { value: '10', spoken: '10 மூட்டை' }, unit: 'bag', rate: null }],
        other_ledger: null, amount: { value: '4400', spoken: '4400 ரூபாய்' }, amount_includes_tax: true, gst_rate_percent: '18', narration: null, missing: [],
      });
    });
    const r = await handleUtterance(db, companyId, {
      transcript: 'ராஜேஷ் டிரேடர்ஸ்-க்கு பத்து மூட்டை சிமெண்ட் ரொக்க விற்பனை, நாலாயிரத்து நானூறு ரூபாய், 18% ஜிஎஸ்டி சேர்த்து',
      confidence: 0.9,
    });
    expect(context).toContain('reply_language: Tamil');
    expect(context).toContain('now: ராஜேஷ் டிரேடர்ஸ்');
    expect(context).toContain('4400 ரூபாய்');            // normalised before the model sees it
    expect(r).toMatchObject({ kind: 'voucher', lang: 'ta' });
    expect(r.speech).toContain('ரொக்க விற்பனை — Rajesh Traders-க்கு.');
    expect(r.speech).toContain('மொத்தம் 4,400 ரூபாய், இதில் ஜிஎஸ்டி 671 ரூபாய் 18 பைசா.');
    expect(r.speech).toContain('"சரி" என்று சொல்லுங்கள்');

    const posted = await handleUtterance(db, companyId, { transcript: 'சரி', sessionId: r.sessionId });
    expect(posted.kind).toBe('posted');
    expect(posted.speech).toMatch(/^பதிவு செய்யப்பட்டது\. விற்பனை எண் \d+\.$/);
  });

  it('answers an outstanding query in Tamil', async () => {
    createMock.mockImplementationOnce(async (req: { messages: { content: string }[] }) => {
      const p = /(p\d+): party "ABC Corp"/.exec(req.messages[0].content)![1];
      return toolUse('query_outstanding', { side: 'RECEIVABLE', party: { candidate_id: p, spoken: 'ஏபிசி கார்ப்' }, period: 'THIS_QUARTER' });
    });
    const r = await handleUtterance(db, companyId, { transcript: 'ஏபிசி கார்ப் இந்த காலாண்டு எவ்வளவு பாக்கி?' });
    expect(r).toMatchObject({ kind: 'answer', lang: 'ta' });
    expect(r.speech).toContain('ABC Corp உங்களுக்கு மொத்தம்');
    expect(r.speech).toContain('தர வேண்டும்');
  });

  it('replies in Tanglish when picked, even to Tamil script, and posts on "sari"', async () => {
    let context = '';
    createMock.mockImplementationOnce(async (req: { messages: { content: string }[] }) => {
      context = req.messages[0].content;
      const p = /(p\d+): party "Rajesh Traders"/.exec(context)![1];
      const i = /(i\d+): item "Cement OPC 53 Grade"/.exec(context)![1];
      return toolUse('record_voucher', {
        voucher_type: 'SALES', date: '', party: { candidate_id: p, spoken: 'ராஜேஷ் டிரேடர்ஸ்' }, payment_mode: 'CASH',
        items: [{ entity: { candidate_id: i, spoken: 'சிமெண்ட்' }, quantity: { value: '10', spoken: '10 மூட்டை' }, unit: 'bag', rate: { value: '', spoken: '' } }],
        other_ledger: { candidate_id: '', spoken: '' }, amount: { value: '4400', spoken: '4400 ரூபாய்' }, amount_includes_tax: 'YES', gst_rate_percent: '18', narration: '', missing: [],
      });
    });
    const r = await handleUtterance(db, companyId, {
      transcript: 'ராஜேஷ் டிரேடர்ஸ்-க்கு பத்து மூட்டை சிமெண்ட் ரொக்க விற்பனை, நாலாயிரத்து நானூறு ரூபாய், 18% ஜிஎஸ்டி சேர்த்து', lang: 'tanglish',
    });
    expect(context).toContain('reply_language: Tanglish');
    expect(r).toMatchObject({ kind: 'voucher', lang: 'tanglish' });
    expect(r.speech).toContain('Rajesh Traders-ku cash sale.');
    expect(r.speech).toContain('Total 4,400 rupees, adhula GST 671 rupees 18 paise.');
    expect(r.speech).toContain('"sari" sollunga');
    expect(r.speech).not.toMatch(/[஀-௿]/);   // no Tamil script: an English voice reads it
    const posted = await handleUtterance(db, companyId, { transcript: 'sari', sessionId: r.sessionId, lang: 'tanglish' });
    expect(posted.speech).toMatch(/^Post panniyachu\. Sale number \d+\.$/);
  });

  it('asks for the supplier bill number on a credit purchase, in Tanglish', async () => {
    createMock.mockImplementationOnce(async (req: { messages: { content: string }[] }) => {
      const p = /(p\d+): party "Shree Balaji Cement Agency"/.exec(req.messages[0].content)![1];
      return toolUse('record_voucher', {
        voucher_type: 'PURCHASE', date: '', party: { candidate_id: p, spoken: 'Shree Balaji Cement' }, payment_mode: 'CREDIT', items: [],
        other_ledger: { candidate_id: '', spoken: '' }, amount: { value: '8000', spoken: '8000' }, amount_includes_tax: 'YES', gst_rate_percent: '28',
        bill_no: '', narration: '', missing: [],
      });
    });
    const r = await handleUtterance(db, companyId, { transcript: 'Shree Balaji Cement kitta credit-la 8000 rupees purchase, 28% GST serthu', lang: 'tanglish' });
    expect(r).toMatchObject({ kind: 'clarify', speech: 'Shree Balaji Cement Agency bill number enna?' });
  });

  it('never sends Tamil script to the English voice in Tanglish mode', async () => {
    createMock.mockImplementationOnce(async () => toolUse('clarify', { question: 'எந்த வாடிக்கையாளருக்கு?' }));
    const r = await handleUtterance(db, companyId, { transcript: 'oru sale podu', lang: 'tanglish' });
    expect(r).toMatchObject({ kind: 'clarify', lang: 'tanglish', speech: 'Konjam thirumba sollunga?' });
  });

  it('uses Tamil when the user picked Tamil but typed romanised Tamil', async () => {
    createMock.mockImplementationOnce(async () => toolUse('clarify', { question: 'எந்த வாடிக்கையாளருக்கு?' }));
    const r = await handleUtterance(db, companyId, { transcript: 'oru vitpanai podu', lang: 'ta' });
    expect(r).toMatchObject({ kind: 'clarify', lang: 'ta', speech: 'எந்த வாடிக்கையாளருக்கு?' });
  });
});
