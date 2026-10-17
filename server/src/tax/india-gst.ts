import { divRound } from '../lib/money';

const PPM = 1_000_000n;
/** Union territories without a legislature charge UTGST instead of SGST. */
export const UT_NO_LEGISLATURE = new Set(['04', '26', '31', '35', '38']);

export type Component = 'CGST' | 'SGST' | 'UTGST' | 'IGST' | 'CESS';

export interface TaxInputLine {
  lineNo: number;
  amountMinor: bigint;   // taxable value, or gross when pricesIncludeTax
  ratePpm: number;       // 18 % = 180000
  cessPpm?: number;
}

export interface GstOptions {
  supplierState: string;
  placeOfSupply: string;
  pricesIncludeTax: boolean;
  roundToRupee: boolean;
  /** Supplies to an SEZ, or exports, are inter-state (IGST) whatever the states (IGST Act s.7(5)). */
  forceInterState?: boolean;
}

export interface TaxComponentLine {
  lineNo: number;
  component: Component;
  ratePpm: number;
  taxableMinor: bigint;
  taxMinor: bigint;
}

export interface GstResult {
  intraState: boolean;
  taxes: TaxComponentLine[];
  taxableMinor: bigint;
  taxMinor: bigint;
  roundOffMinor: bigint;
  grandTotalMinor: bigint;
  taxableFor: (lineNo: number) => bigint;
}

/**
 * Pure GST computation. Amounts must be non-negative; credit/debit notes compute
 * on absolute values and the posting rules flip the sign.
 */
export function computeGst(lines: TaxInputLine[], o: GstOptions): GstResult {
  const intra = !o.forceInterState && o.supplierState === o.placeOfSupply;
  const local: Component = UT_NO_LEGISLATURE.has(o.placeOfSupply) ? 'UTGST' : 'SGST';
  const taxes: TaxComponentLine[] = [];
  const byLine = new Map<number, bigint>();
  let taxable = 0n;
  let gross = 0n;

  for (const l of lines) {
    if (l.amountMinor < 0n) throw new Error('computeGst: negative amount');
    if (l.ratePpm % 2 !== 0) throw new Error(`computeGst: rate ${l.ratePpm} ppm cannot be split`);
    const cess = l.cessPpm ?? 0;
    const base = o.pricesIncludeTax
      ? divRound(l.amountMinor * PPM, PPM + BigInt(l.ratePpm + cess))
      : l.amountMinor;
    const parts: [Component, number][] = l.ratePpm === 0
      ? []
      : intra
        ? [['CGST', l.ratePpm / 2], [local, l.ratePpm / 2]]
        : [['IGST', l.ratePpm]];
    if (cess) parts.push(['CESS', cess]);
    for (const [component, ratePpm] of parts) {
      taxes.push({
        lineNo: l.lineNo, component, ratePpm, taxableMinor: base,
        taxMinor: divRound(base * BigInt(ratePpm), PPM),
      });
    }
    byLine.set(l.lineNo, base);
    taxable += base;
    gross += l.amountMinor;
  }

  const tax = taxes.reduce((s, t) => s + t.taxMinor, 0n);
  const exact = taxable + tax;
  const total = o.pricesIncludeTax ? gross
    : o.roundToRupee ? divRound(exact, 100n) * 100n
    : exact;

  return {
    intraState: intra,
    taxes,
    taxableMinor: taxable,
    taxMinor: tax,
    roundOffMinor: total - exact,
    grandTotalMinor: total,
    taxableFor: (n: number) => byLine.get(n) ?? 0n,
  };
}

/** GST slabs that a printed rate may legitimately take (old and current). */
export const KNOWN_GST_RATES_PPM = new Set(
  [0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 14, 18, 28, 40].map((p) => Math.round(p * 10_000)),
);
