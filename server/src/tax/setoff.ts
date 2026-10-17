/**
 * GSTR-3B set-off: which input credit pays which output tax, and what is left to pay in cash.
 *
 * Order (CGST Act s.49(5), s.49A, rule 88A):
 *   1. IGST credit pays IGST, then CGST and SGST/UTGST (in any proportion), and must be used up first.
 *   2. CGST credit pays CGST, then IGST. Never SGST/UTGST.
 *   3. SGST (or UTGST) credit pays SGST (UTGST), then IGST. Never CGST.
 *   4. Cess credit pays cess only.
 * Tax under reverse charge is always paid in cash (s.49(4) allows credit only for output tax), so it is
 * kept out of the set-off; the credit for it, once paid, is part of the input credit.
 */
export type Head = 'IGST' | 'CGST' | 'SGST' | 'UTGST' | 'CESS';
export const HEADS: Head[] = ['IGST', 'CGST', 'SGST', 'UTGST', 'CESS'];

export interface HeadTotals { outputMinor: bigint; rcmMinor: bigint; itcMinor: bigint }

export interface HeadSetOff extends HeadTotals {
  component: Head;
  /** Output tax of this head paid with credit (of any head). */
  paidByCreditMinor: bigint;
  /** Output tax left after credit, plus reverse-charge tax: paid in cash. */
  cashMinor: bigint;
  /** This head's credit left over, carried to next month. */
  carryForwardMinor: bigint;
}

const min = (a: bigint, b: bigint) => (a < b ? a : b);
const pos = (a: bigint) => (a > 0n ? a : 0n);

export function setOff(totals: Record<Head, HeadTotals>): HeadSetOff[] {
  // Credit notes in excess of sales add to that head's credit; debit notes and reversals in excess of
  // purchases (negative credit) add to what is payable.
  const due = {} as Record<Head, bigint>;
  const credit = {} as Record<Head, bigint>;
  const paid = {} as Record<Head, bigint>;
  for (const h of HEADS) {
    const { outputMinor: out, itcMinor: itc } = totals[h];
    due[h] = pos(out) + pos(-itc);
    credit[h] = pos(itc) + pos(-out);
    paid[h] = 0n;
  }
  const use = (from: Head, to: Head, cap?: bigint) => {
    const amt = min(min(credit[from], due[to]), cap ?? due[to]);
    if (amt <= 0n) return;
    credit[from] -= amt;
    due[to] -= amt;
    paid[to] += amt;
  };

  // 1. IGST credit: IGST first, then where CGST / SGST credit falls short (least cash), then the rest.
  use('IGST', 'IGST');
  const states: Head[] = ['SGST', 'UTGST'];
  use('IGST', 'CGST', pos(due.CGST - credit.CGST));
  for (const s of states) use('IGST', s, pos(due[s] - credit[s]));
  use('IGST', 'CGST');
  for (const s of states) use('IGST', s);
  // 2. CGST credit.
  use('CGST', 'CGST');
  use('CGST', 'IGST');
  // 3. SGST / UTGST credit (for IGST only once CGST credit is used up, which step 2 did).
  for (const s of states) { use(s, s); use(s, 'IGST'); }
  // 4. Cess.
  use('CESS', 'CESS');

  return HEADS.map((h) => ({
    component: h,
    ...totals[h],
    paidByCreditMinor: paid[h],
    cashMinor: due[h] + pos(totals[h].rcmMinor),
    carryForwardMinor: credit[h],
  }));
}
