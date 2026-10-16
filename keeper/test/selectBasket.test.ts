import { describe, expect, it, vi } from 'vitest';
import { selectBasket, type BasketDeps } from '../src/round/selectBasket';
import { testConfig } from './helpers/config';
import type { PodMarket } from '../../shared/types';
import type { MintCheck } from '../src/chain/mintCheck';

const NOW = 1_800_000_000;
const SOL = 1_000_000_000n;

function market(i: number, o: Partial<PodMarket> = {}): PodMarket {
  return {
    mint: `MINT${i}`,
    pool: `POOL${i}`,
    symbol: `C${i}`,
    name: `Coin ${i}`,
    image: `https://img/${i}.png`,
    quoteMint: 'So11111111111111111111111111111111111111112',
    quoteTicker: 'SOL',
    quoteUsd: 200,
    priceUsd: 0.01,
    marketCapUsd: 1_000_000 - i * 1000,
    liquidityUsd: 100_000,
    volume24hUsd: 50_000,
    trades24h: 500,
    holders: 400,
    change24h: 1.5,
    createdAt: NOW - 7 * 86400,
    suspect: false,
    paused: false,
    ...o,
  };
}

const okMint: MintCheck = { ok: true, decimals: 6, tokenProgram: 'Tokenkeg' };

function deps(o: Partial<BasketDeps> = {}): BasketDeps {
  return {
    checkMint: async () => okMint,
    quoteImpactBps: async () => 50,
    ...o,
  };
}

const cfg = testConfig();
const run = (markets: PodMarket[], d = deps(), pot = 5n * SOL, c = cfg) =>
  selectBasket(markets, c, pot, 200, d, NOW);

describe('selectBasket', () => {
  it('ranks by market cap desc regardless of input order', async () => {
    const ms = [market(3), market(1), market(2)];
    const r = await run(ms);
    expect(r.coins.map((c) => c.mint)).toEqual(['MINT1', 'MINT2', 'MINT3']);
    expect(r.rejected).toEqual([]);
  });

  it('fills BasketCoin from market and mint check', async () => {
    const r = await run([market(1)], deps({ checkMint: async () => ({ ok: true, decimals: 9, tokenProgram: 'Tok22' }) }));
    expect(r.coins[0]).toMatchObject({
      mint: 'MINT1', symbol: 'C1', pool: 'POOL1', decimals: 9, tokenProgram: 'Tok22', holders: 400,
    });
  });

  it('limits to maxCoins and does not examine the rest', async () => {
    const checkMint = vi.fn(async () => okMint);
    const ms = Array.from({ length: 8 }, (_, i) => market(i));
    const r = await run(ms, deps({ checkMint }));
    expect(r.coins).toHaveLength(5);
    expect(checkMint).toHaveBeenCalledTimes(5);
    const r3 = await selectBasket(ms, testConfig({ maxCoins: 3 }), 5n * SOL, 200, deps(), NOW);
    expect(r3.coins.map((c) => c.mint)).toEqual(['MINT0', 'MINT1', 'MINT2']);
  });

  it('dedupes by mint', async () => {
    const r = await run([market(1), market(1, { symbol: 'DUP', marketCapUsd: 1 }), market(2)]);
    expect(r.coins.map((c) => c.mint)).toEqual(['MINT1', 'MINT2']);
  });

  it('excludes POD5 and excludeMints with reasons', async () => {
    const c = testConfig({ pod5Mint: 'MINT1', excludeMints: ['MINT2'] });
    const r = await selectBasket([market(1), market(2), market(3)], c, 5n * SOL, 200, deps(), NOW);
    expect(r.coins.map((x) => x.mint)).toEqual(['MINT3']);
    expect(r.rejected.map((x) => x.mint)).toEqual(['MINT1', 'MINT2']);
    expect(r.rejected.every((x) => x.reason.length > 0)).toBe(true);
  });

  const cases: [string, Partial<PodMarket>, RegExp][] = [
    ['suspect', { suspect: true }, /suspect/],
    ['paused', { paused: true }, /paused/],
    ['too young', { createdAt: NOW - 3600 }, /age 1\.0h < 24h/],
    ['low liquidity', { liquidityUsd: 1200 }, /liquidity \$1\.2K < \$5K/],
    ['few holders', { holders: 10 }, /holders 10 < 50/],
    ['low volume', { volume24hUsd: 100 }, /volume/],
    ['few trades', { trades24h: 3 }, /trades 3 < 20/],
  ];
  for (const [name, o, re] of cases) {
    it(`rejects: ${name}`, async () => {
      const r = await run([market(1, o), market(2)]);
      expect(r.coins.map((c) => c.mint)).toEqual(['MINT2']);
      expect(r.rejected).toHaveLength(1);
      expect(r.rejected[0]).toMatchObject({ mint: 'MINT1', symbol: 'C1' });
      expect(r.rejected[0]!.reason).toMatch(re);
    });
  }

  it('rejects when mint check not ok, using its reason', async () => {
    const r = await run(
      [market(1), market(2)],
      deps({
        checkMint: async (m) => (m === 'MINT1' ? { ok: false, reason: 'freeze authority set', decimals: 6, tokenProgram: 'T' } : okMint),
      }),
    );
    expect(r.coins.map((c) => c.mint)).toEqual(['MINT2']);
    expect(r.rejected[0]!.reason).toBe('freeze authority set');
  });

  it('rejects when no Jupiter route', async () => {
    const r = await run([market(1), market(2)], deps({ quoteImpactBps: async (m) => (m === 'MINT1' ? null : 10) }));
    expect(r.coins.map((c) => c.mint)).toEqual(['MINT2']);
    expect(r.rejected[0]!.reason).toBe('no Jupiter route');
  });

  it('rejects on high impact, accepts exactly at the limit', async () => {
    const r = await run([market(1), market(2)], deps({ quoteImpactBps: async (m) => (m === 'MINT1' ? 410 : 300) }));
    expect(r.coins.map((c) => c.mint)).toEqual(['MINT2']);
    expect(r.rejected[0]!.reason).toBe('impact 4.1% > 3.0%');
  });

  it('deps throwing rejects the coin instead of throwing', async () => {
    const r = await run(
      [market(1), market(2), market(3)],
      deps({
        checkMint: async (m) => {
          if (m === 'MINT1') throw new Error('rpc down');
          return okMint;
        },
        quoteImpactBps: async (m) => {
          if (m === 'MINT2') throw new Error('timeout');
          return 10;
        },
      }),
    );
    expect(r.coins.map((c) => c.mint)).toEqual(['MINT3']);
    expect(r.rejected.map((x) => x.mint)).toEqual(['MINT1', 'MINT2']);
    expect(r.rejected[0]!.reason).toMatch(/rpc down/);
    expect(r.rejected[1]!.reason).toMatch(/timeout/);
  });

  it('quotes with min(pot/maxCoins, liquidity cap)', async () => {
    const quote = vi.fn(async () => 10);
    // liquidity $10,000 * 1% / $200 = 0.5 SOL; pot/5 = 1 SOL -> cap wins for MINT1
    await run([market(1, { liquidityUsd: 10_000 }), market(2, { liquidityUsd: 10_000_000 })], deps({ quoteImpactBps: quote }));
    expect(quote).toHaveBeenNthCalledWith(1, 'MINT1', 500_000_000n);
    expect(quote).toHaveBeenNthCalledWith(2, 'MINT2', SOL);
  });

  it('potLamports 0 skips the impact check entirely', async () => {
    const quote = vi.fn(async () => null);
    const r = await run([market(1)], deps({ quoteImpactBps: quote }), 0n);
    expect(quote).not.toHaveBeenCalled();
    expect(r.coins).toHaveLength(1);
  });

  it('cheap checks run before deps are called', async () => {
    const checkMint = vi.fn(async () => okMint);
    await run([market(1, { suspect: true })], deps({ checkMint }));
    expect(checkMint).not.toHaveBeenCalled();
  });

  it('empty market list', async () => {
    expect(await run([])).toEqual({ coins: [], rejected: [] });
  });
});
