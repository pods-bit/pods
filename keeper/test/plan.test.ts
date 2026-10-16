import { describe, expect, it } from 'vitest';
import {
  allocateProRata,
  computePot,
  deliveryDecision,
  estimateRoundFees,
  liquidityCapLamports,
  qualifyHolders,
  sliceAmounts,
  type Holder,
} from '../src/round/plan';

const SOL = 1_000_000_000n;

describe('computePot', () => {
  const base = {
    balanceLamports: 2n * SOL,
    opReserveLamports: SOL / 20n,
    estFeesLamports: 1_000_000n,
    potCapLamports: null,
    minPotLamports: SOL / 20n,
  };
  it('subtracts reserve and fees', () => {
    expect(computePot(base)).toEqual({ pot: 2n * SOL - SOL / 20n - 1_000_000n, skip: null });
  });
  it('applies the cap', () => {
    expect(computePot({ ...base, potCapLamports: SOL }).pot).toBe(SOL);
  });
  it('cap above pot has no effect', () => {
    expect(computePot({ ...base, potCapLamports: 10n * SOL }).pot).toBe(2n * SOL - SOL / 20n - 1_000_000n);
  });
  it('skips below the minimum', () => {
    const r = computePot({ ...base, balanceLamports: SOL / 10n });
    expect(r.skip).not.toBeNull();
    expect(r.pot).toBeGreaterThanOrEqual(0n);
  });
  it('exactly the minimum does not skip', () => {
    const r = computePot({ ...base, balanceLamports: base.opReserveLamports + base.estFeesLamports + base.minPotLamports });
    expect(r.skip).toBeNull();
  });
  it('never negative when balance is below reserve', () => {
    const r = computePot({ ...base, balanceLamports: 10n });
    expect(r.pot).toBe(0n);
    expect(r.skip).not.toBeNull();
  });
  it('cap that is below the minimum skips', () => {
    expect(computePot({ ...base, potCapLamports: 1n }).skip).not.toBeNull();
  });
});

describe('sliceAmounts', () => {
  it('splits equally', () => {
    const r = sliceAmounts(1000n, [10_000n, 10_000n, 10_000n, 10_000n, 10_000n]);
    expect(r.slices).toEqual([200n, 200n, 200n, 200n, 200n]);
    expect(r.unspent).toBe(0n);
  });
  it('floors and reports remainder as unspent', () => {
    const r = sliceAmounts(1000n, [9999n, 9999n, 9999n]);
    expect(r.slices).toEqual([333n, 333n, 333n]);
    expect(r.unspent).toBe(1n);
  });
  it('caps individual slices', () => {
    const r = sliceAmounts(1000n, [100n, 10_000n]);
    expect(r.slices).toEqual([100n, 500n]);
    expect(r.unspent).toBe(400n);
  });
  it('empty caps -> everything unspent', () => {
    expect(sliceAmounts(1000n, [])).toEqual({ slices: [], unspent: 1000n });
  });
  it('zero cap gives zero slice', () => {
    expect(sliceAmounts(100n, [0n, 100n]).slices).toEqual([0n, 50n]);
  });
  it('sum + unspent == pot', () => {
    const r = sliceAmounts(12345n, [50n, 7000n, 7000n]);
    expect(r.slices.reduce((a, b) => a + b, 0n) + r.unspent).toBe(12345n);
  });
});

describe('liquidityCapLamports', () => {
  it('converts a share of liquidity to lamports', () => {
    // $10,000 * 1% = $100 ; at $200/SOL = 0.5 SOL
    expect(liquidityCapLamports(10_000, 0.01, 200)).toBe(500_000_000n);
  });
  it('floors', () => {
    expect(liquidityCapLamports(1, 1, 3)).toBe(333_333_333n);
  });
  it('0 when solUsd <= 0', () => {
    expect(liquidityCapLamports(10_000, 0.01, 0)).toBe(0n);
    expect(liquidityCapLamports(10_000, 0.01, -5)).toBe(0n);
  });
  it('0 for zero or invalid liquidity', () => {
    expect(liquidityCapLamports(0, 0.01, 100)).toBe(0n);
    expect(liquidityCapLamports(NaN, 0.01, 100)).toBe(0n);
  });
});

describe('qualifyHolders', () => {
  const h = (owner: string, amountRaw: bigint): Holder => ({ owner, amountRaw });
  it('boundary at exactly $30 is inclusive (price 0.003, 6 decimals)', () => {
    const p = { priceUsd: 0.003, decimals: 6, minHoldUsd: 30 };
    const exact = 10_000n * 10n ** 6n; // 10,000 tokens * 0.003 = $30
    const out = qualifyHolders([h('a', exact), h('b', exact - 1n), h('c', exact + 1n)], p);
    expect(out.map((x) => x.owner)).toEqual(['a', 'c']);
  });
  it('boundary at exactly $30 with integer price', () => {
    const p = { priceUsd: 1.5, decimals: 9, minHoldUsd: 30 };
    const exact = 20n * 10n ** 9n;
    expect(qualifyHolders([h('a', exact), h('b', exact - 1n)], p).map((x) => x.owner)).toEqual(['a']);
  });
  it('handles very small prices', () => {
    const p = { priceUsd: 1e-9, decimals: 6, minHoldUsd: 30 };
    const need = 30_000_000_000n * 10n ** 6n; // 3e10 tokens at 1e-9 = $30
    expect(qualifyHolders([h('a', need), h('b', need - 1n)], p).map((x) => x.owner)).toEqual(['a']);
  });
  it('unknown price qualifies nobody', () => {
    expect(qualifyHolders([h('a', 10n ** 15n)], { priceUsd: 0, decimals: 6, minHoldUsd: 30 })).toEqual([]);
    expect(qualifyHolders([h('a', 10n ** 15n)], { priceUsd: NaN, decimals: 6, minHoldUsd: 30 })).toEqual([]);
  });
  it('empty in, empty out; zero balances dropped', () => {
    expect(qualifyHolders([], { priceUsd: 1, decimals: 6, minHoldUsd: 0 })).toEqual([]);
    expect(qualifyHolders([h('a', 0n)], { priceUsd: 1, decimals: 6, minHoldUsd: 0 })).toEqual([]);
  });
});

/** mulberry32 seeded PRNG. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('allocateProRata', () => {
  const h = (owner: string, amountRaw: bigint): Holder => ({ owner, amountRaw });
  it('splits proportionally with dust', () => {
    const r = allocateProRata(100n, [h('a', 1n), h('b', 1n), h('c', 1n)]);
    expect([...r.credits.values()]).toEqual([33n, 33n, 33n]);
    expect(r.dust).toBe(1n);
  });
  it('single holder gets everything', () => {
    const r = allocateProRata(12345n, [h('a', 7n)]);
    expect(r.credits.get('a')).toBe(12345n);
    expect(r.dust).toBe(0n);
  });
  it('zero balances are ignored / all-zero -> dust', () => {
    const r = allocateProRata(500n, [h('a', 0n), h('b', 0n)]);
    expect(r.credits.size).toBe(0);
    expect(r.dust).toBe(500n);
    const r2 = allocateProRata(500n, [h('a', 0n), h('b', 5n)]);
    expect(r2.credits.get('b')).toBe(500n);
    expect(r2.credits.has('a')).toBe(false);
  });
  it('empty holders -> dust = total', () => {
    const r = allocateProRata(777n, []);
    expect(r.credits.size).toBe(0);
    expect(r.dust).toBe(777n);
  });
  it('omits zero credits', () => {
    const r = allocateProRata(1n, [h('a', 1n), h('b', 1_000_000n)]);
    expect(r.credits.has('a')).toBe(false);
    expect(r.dust).toBe(1n - [...r.credits.values()].reduce((x, y) => x + y, 0n));
  });
  it('zero total -> no credits', () => {
    const r = allocateProRata(0n, [h('a', 5n)]);
    expect(r.credits.size).toBe(0);
    expect(r.dust).toBe(0n);
  });
  it('is order independent', () => {
    const hs = [h('a', 3n), h('b', 7n), h('c', 11n), h('d', 13n)];
    const r1 = allocateProRata(1_000_003n, hs);
    const r2 = allocateProRata(1_000_003n, [...hs].reverse());
    expect([...r1.credits.entries()]).toEqual([...r2.credits.entries()]);
    expect(r1.dust).toBe(r2.dust);
  });
  it('invariant sum(credits)+dust == total over random inputs (seeded)', () => {
    const rand = rng(0xc0ffee);
    for (let iter = 0; iter < 300; iter++) {
      const n = Math.floor(rand() * 40);
      const holders: Holder[] = [];
      for (let i = 0; i < n; i++) {
        const mag = Math.floor(rand() * 18);
        const amt = BigInt(Math.floor(rand() * 10 ** Math.min(mag, 15))) * (rand() < 0.1 ? 0n : 1n) + (rand() < 0.5 ? BigInt(mag) : 0n);
        holders.push(h(`w${Math.floor(rand() * 30)}`, amt)); // duplicate owners possible
      }
      const total = BigInt(Math.floor(rand() * 1e15)) * BigInt(Math.floor(rand() * 1e6) + 1);
      const r = allocateProRata(total, holders);
      let sum = 0n;
      for (const v of r.credits.values()) {
        expect(v).toBeGreaterThan(0n);
        sum += v;
      }
      expect(sum + r.dust).toBe(total);
      expect(r.dust).toBeGreaterThanOrEqual(0n);
      // shuffled input gives identical result
      const shuffled = [...holders].sort(() => rand() - 0.5);
      const r2 = allocateProRata(total, shuffled);
      expect([...r2.credits.entries()]).toEqual([...r.credits.entries()]);
      expect(r2.dust).toBe(r.dust);
    }
  });
});

describe('deliveryDecision', () => {
  const base = {
    owedRaw: 1_000_000_000n, // 1000 tokens @ 6 decimals
    hasAta: false,
    tokenPriceUsd: 0.01, // $10 total
    decimals: 6,
    solUsd: 100,
    rentLamports: 2_039_280n, // ~0.00203928 SOL = ~$0.204
    rentMargin: 1.5,
  };
  it('has ATA -> send all', () => {
    expect(deliveryDecision({ ...base, hasAta: true, owedRaw: 5n })).toEqual({ kind: 'send', amountRaw: 5n });
  });
  it('zero owed -> wait (even with ATA)', () => {
    expect(deliveryDecision({ ...base, owedRaw: 0n, hasAta: true })).toEqual({ kind: 'wait' });
    expect(deliveryDecision({ ...base, owedRaw: 0n })).toEqual({ kind: 'wait' });
  });
  it('below rent margin waits', () => {
    // rentUsd=0.2039; need >= 0.3059. 20 tokens @0.01 = $0.20 -> wait
    expect(deliveryDecision({ ...base, owedRaw: 20_000_000n })).toEqual({ kind: 'wait' });
  });
  it('above margin opens and withholds ceil(rent in tokens)', () => {
    const r = deliveryDecision(base);
    // rentUsd = 2_039_280 * 100 / 1e9 = 0.203928 ; tokens = 20.3928 -> 20_392_800 raw (exact) 
    expect(r).toEqual({ kind: 'open', amountRaw: 1_000_000_000n - 20_392_800n, rentWithheldRaw: 20_392_800n });
  });
  it('withheld is rounded up', () => {
    const r = deliveryDecision({ ...base, tokenPriceUsd: 0.03 });
    // 0.203928 / 0.03 = 6.7976 tokens -> 6_797_600 exactly; use a non-exact price to force ceil
    expect(r.kind).toBe('open');
    const r2 = deliveryDecision({ ...base, tokenPriceUsd: 0.07, owedRaw: 10_000_000_000n });
    if (r2.kind !== 'open') throw new Error('expected open');
    // withheld*price >= rentUsd and (withheld-1)*price < rentUsd
    const w = Number(r2.rentWithheldRaw);
    expect((w / 1e6) * 0.07).toBeGreaterThanOrEqual(0.203928 - 1e-12);
    expect(((w - 1) / 1e6) * 0.07).toBeLessThan(0.203928);
    expect(r2.amountRaw + r2.rentWithheldRaw).toBe(10_000_000_000n);
  });
  it('unknown token price waits', () => {
    expect(deliveryDecision({ ...base, tokenPriceUsd: 0 })).toEqual({ kind: 'wait' });
    expect(deliveryDecision({ ...base, tokenPriceUsd: NaN })).toEqual({ kind: 'wait' });
  });
  it('unknown sol price waits', () => {
    expect(deliveryDecision({ ...base, solUsd: 0 })).toEqual({ kind: 'wait' });
  });
  it('exactly at margin opens', () => {
    // price 1, solUsd 1, rent 1e9 lamports => rentUsd = 1; margin 2 => need $2; decimals 0
    const r = deliveryDecision({
      owedRaw: 2n, hasAta: false, tokenPriceUsd: 1, decimals: 0, solUsd: 1, rentLamports: 1_000_000_000n, rentMargin: 2,
    });
    expect(r).toEqual({ kind: 'open', amountRaw: 1n, rentWithheldRaw: 1n });
    expect(
      deliveryDecision({
        owedRaw: 1n, hasAta: false, tokenPriceUsd: 1, decimals: 0, solUsd: 1, rentLamports: 1_000_000_000n, rentMargin: 2,
      }),
    ).toEqual({ kind: 'wait' });
  });
  it('never withholds the whole balance', () => {
    const r = deliveryDecision({
      owedRaw: 1n, hasAta: false, tokenPriceUsd: 1, decimals: 0, solUsd: 1, rentLamports: 1_000_000_000n, rentMargin: 0.5,
    });
    expect(r).toEqual({ kind: 'wait' });
  });
});

describe('estimateRoundFees', () => {
  it('zero coins -> zero', () => {
    expect(estimateRoundFees({ coins: 0, recipients: 100, transfersPerTx: 18, priorityFeeMicroLamports: 50_000 })).toBe(0n);
  });
  it('matches the formula', () => {
    // swap fee: 5000 + ceil(50000*200000/1e6)=10000 -> 15000 ; delivery: 5000 + ceil(50000*18*30000/1e6)=27000 -> 32000
    // coins=5, recipients=100 -> 500 transfers -> ceil(500/18)=28 txs
    expect(estimateRoundFees({ coins: 5, recipients: 100, transfersPerTx: 18, priorityFeeMicroLamports: 50_000 })).toBe(
      5n * 15_000n + 28n * 32_000n,
    );
  });
  it('no priority fee -> base fees only', () => {
    expect(estimateRoundFees({ coins: 2, recipients: 18, transfersPerTx: 18, priorityFeeMicroLamports: 0 })).toBe(
      2n * 5000n + 2n * 5000n,
    );
  });
  it('is monotonic in recipients and coins', () => {
    const f = (coins: number, recipients: number) =>
      estimateRoundFees({ coins, recipients, transfersPerTx: 18, priorityFeeMicroLamports: 50_000 });
    expect(f(5, 200)).toBeGreaterThan(f(5, 100));
    expect(f(5, 100)).toBeGreaterThan(f(3, 100));
  });
});
