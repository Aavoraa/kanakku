import Decimal from 'decimal.js';

/** One stock movement, sorted by (voucher_date, chain_seq). unitCost null = inward at running cost (e.g. sales return). */
export interface Move {
  qty: Decimal;
  unitCost: Decimal | null;
}

export interface Closing {
  qty: Decimal;
  value: Decimal; // rupees, unrounded
}

export class NegativeStockError extends Error {}

export function closingFifo(moves: Move[], allowNegative = false): Closing {
  const layers: { qty: Decimal; cost: Decimal }[] = [];
  let lastCost = new Decimal(0);
  let negativeQty = new Decimal(0);
  for (const m of moves) {
    if (m.qty.gt(0)) {
      const cost = m.unitCost ?? currentFifoCost(layers, lastCost);
      // Inward first settles any negative stock (valued at this cost).
      let qty = m.qty;
      if (negativeQty.gt(0)) {
        const settle = Decimal.min(qty, negativeQty);
        negativeQty = negativeQty.minus(settle);
        qty = qty.minus(settle);
      }
      if (qty.gt(0)) layers.push({ qty, cost });
      lastCost = cost;
      continue;
    }
    let out = m.qty.neg();
    while (out.gt(0)) {
      const head = layers[0];
      if (!head) {
        if (!allowNegative) throw new NegativeStockError('stock would go negative');
        negativeQty = negativeQty.plus(out);
        break;
      }
      const take = Decimal.min(head.qty, out);
      head.qty = head.qty.minus(take);
      out = out.minus(take);
      lastCost = head.cost;
      if (head.qty.isZero()) layers.shift();
    }
  }
  const qty = layers.reduce((s, l) => s.plus(l.qty), new Decimal(0)).minus(negativeQty);
  const value = layers.reduce((s, l) => s.plus(l.qty.times(l.cost)), new Decimal(0))
    .minus(negativeQty.times(lastCost));
  return { qty, value };
}

function currentFifoCost(layers: { qty: Decimal; cost: Decimal }[], fallback: Decimal): Decimal {
  const q = layers.reduce((s, l) => s.plus(l.qty), new Decimal(0));
  if (q.isZero()) return fallback;
  return layers.reduce((s, l) => s.plus(l.qty.times(l.cost)), new Decimal(0)).div(q);
}

export function closingMovingAverage(moves: Move[], allowNegative = false): Closing {
  let qty = new Decimal(0);
  let value = new Decimal(0);
  let lastAvg = new Decimal(0);
  for (const m of moves) {
    const avg = qty.gt(0) ? value.div(qty) : lastAvg;
    if (m.qty.gt(0)) {
      const cost = m.unitCost ?? avg;
      if (qty.lt(0)) {
        // Inward first settles the units sold while stock was negative, at this cost (as FIFO does);
        // whatever is left over is stock at this cost.
        qty = qty.plus(m.qty);
        value = qty.times(cost);
      } else {
        qty = qty.plus(m.qty);
        value = value.plus(m.qty.times(cost));
      }
      lastAvg = qty.gt(0) ? value.div(qty) : cost;
    } else {
      if (!allowNegative && qty.plus(m.qty).lt(0)) throw new NegativeStockError('stock would go negative');
      qty = qty.plus(m.qty);
      value = value.plus(m.qty.times(avg));   // m.qty is negative
      lastAvg = avg;
    }
  }
  return { qty, value };
}

export function closing(method: 'FIFO' | 'WAVG', moves: Move[], allowNegative = false): Closing {
  return method === 'FIFO' ? closingFifo(moves, allowNegative) : closingMovingAverage(moves, allowNegative);
}
