import type { Config } from '../config';
import type { MintCheck } from '../chain/mintCheck';
import { liquidityCapLamports } from './plan';
import type { BasketCoin, PodMarket, RejectedCoin } from '../../../shared/types';

export interface BasketDeps {
  checkMint(mint: string): Promise<MintCheck>;
  /** Price impact in bps of buying `mint` with `lamports` of SOL; null when no route. */
  quoteImpactBps(mint: string, lamports: bigint): Promise<number | null>;
}

function usd(n: number): string {
  if (!Number.isFinite(n)) return '$?';
  const abs = Math.abs(n);
  const fmt = (v: number) => (v >= 100 ? v.toFixed(0) : v.toFixed(1)).replace(/\.0$/, '');
  if (abs >= 1e9) return `$${fmt(n / 1e9)}B`;
  if (abs >= 1e6) return `$${fmt(n / 1e6)}M`;
  if (abs >= 1e3) return `$${fmt(n / 1e3)}K`;
  return `$${fmt(n)}`;
}

function errMsg(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.length > 80 ? `${m.slice(0, 77)}...` : m;
}

/**
 * Rank markets by marketCapUsd desc and walk down the list, keeping the first coins that
 * pass every check, until cfg.maxCoins are kept. Checks, in order (cheap first):
 *   1. not POD5 itself, not in cfg.excludeMints
 *   2. !suspect, !paused, age >= cfg.minAgeHours (nowSec - createdAt)
 *   3. liquidityUsd >= cfg.minLiqUsd
 *   4. holders >= cfg.minHolders, volume24hUsd >= cfg.minVol24hUsd, trades24h >= cfg.minTrades24h
 *   5. deps.checkMint(mint).ok
 *   6. deps.quoteImpactBps(mint, tentativeSlice) is non-null and <= cfg.maxImpactBps,
 *      where tentativeSlice = min(potLamports / maxCoins, liquidityCapLamports(...)).
 *      Skip this check (treat as pass) when potLamports == 0 (preview mode).
 * Every coin examined and rejected is reported with a short human reason.
 * Coins are deduplicated by mint. deps errors reject that coin, never throw.
 *
 * Notes: once maxCoins are kept, remaining lower-ranked markets are not examined (and not
 * reported). Duplicate mints keep the highest-ranked entry; later duplicates are dropped
 * silently (no rejection row).
 */
export async function selectBasket(
  markets: PodMarket[],
  cfg: Config,
  potLamports: bigint,
  solUsd: number,
  deps: BasketDeps,
  nowSec: number,
): Promise<{ coins: BasketCoin[]; rejected: RejectedCoin[] }> {
  const coins: BasketCoin[] = [];
  const rejected: RejectedCoin[] = [];
  const maxCoins = Math.max(0, Math.floor(cfg.maxCoins));
  const excluded = new Set(cfg.excludeMints);
  if (cfg.pod5Mint) excluded.add(cfg.pod5Mint);

  // Stable sort by mcap desc (ties keep input order); NaN mcap sinks to the bottom.
  const ranked = markets
    .map((m, i) => ({ m, i }))
    .sort((a, b) => {
      const am = Number.isFinite(a.m.marketCapUsd) ? a.m.marketCapUsd : -Infinity;
      const bm = Number.isFinite(b.m.marketCapUsd) ? b.m.marketCapUsd : -Infinity;
      return bm === am ? a.i - b.i : bm > am ? 1 : -1;
    })
    .map((x) => x.m);

  const seen = new Set<string>();
  for (const m of ranked) {
    if (coins.length >= maxCoins) break;
    if (seen.has(m.mint)) continue;
    seen.add(m.mint);

    const reject = (reason: string) => rejected.push({ mint: m.mint, symbol: m.symbol, reason });

    // 1. exclusions
    if (excluded.has(m.mint)) {
      reject(cfg.pod5Mint === m.mint ? 'is POD5 itself' : 'excluded by config');
      continue;
    }
    // 2. flags and age
    if (m.suspect) { reject('flagged suspect'); continue; }
    if (m.paused) { reject('paused'); continue; }
    const ageH = (nowSec - m.createdAt) / 3600;
    if (!(ageH >= cfg.minAgeHours)) {
      reject(`age ${ageH.toFixed(1)}h < ${cfg.minAgeHours}h`);
      continue;
    }
    // 3. liquidity
    if (!(m.liquidityUsd >= cfg.minLiqUsd)) {
      reject(`liquidity ${usd(m.liquidityUsd)} < ${usd(cfg.minLiqUsd)}`);
      continue;
    }
    // 4. activity
    if (!(m.holders >= cfg.minHolders)) { reject(`holders ${m.holders} < ${cfg.minHolders}`); continue; }
    if (!(m.volume24hUsd >= cfg.minVol24hUsd)) {
      reject(`24h volume ${usd(m.volume24hUsd)} < ${usd(cfg.minVol24hUsd)}`);
      continue;
    }
    if (!(m.trades24h >= cfg.minTrades24h)) {
      reject(`24h trades ${m.trades24h} < ${cfg.minTrades24h}`);
      continue;
    }
    // 5. on-chain mint safety
    let mc: MintCheck;
    try {
      mc = await deps.checkMint(m.mint);
    } catch (e) {
      reject(`mint check failed: ${errMsg(e)}`);
      continue;
    }
    if (!mc.ok) { reject(mc.reason ?? 'mint check failed'); continue; }

    // 6. route + price impact
    if (potLamports > 0n) {
      const share = potLamports / BigInt(Math.max(1, maxCoins));
      const cap = liquidityCapLamports(m.liquidityUsd, cfg.maxSliceOfLiq, solUsd);
      const slice = share < cap ? share : cap;
      if (slice <= 0n) { reject('slice too small (liquidity cap)'); continue; }
      let impact: number | null;
      try {
        impact = await deps.quoteImpactBps(m.mint, slice);
      } catch (e) {
        reject(`quote failed: ${errMsg(e)}`);
        continue;
      }
      if (impact === null) { reject('no Jupiter route'); continue; }
      if (!(impact <= cfg.maxImpactBps)) {
        reject(`impact ${(impact / 100).toFixed(1)}% > ${(cfg.maxImpactBps / 100).toFixed(1)}%`);
        continue;
      }
    }

    coins.push({
      mint: m.mint,
      symbol: m.symbol,
      name: m.name,
      image: m.image,
      pool: m.pool,
      decimals: mc.decimals,
      tokenProgram: mc.tokenProgram,
      priceUsd: m.priceUsd,
      marketCapUsd: m.marketCapUsd,
      liquidityUsd: m.liquidityUsd,
      volume24hUsd: m.volume24hUsd,
      change24h: m.change24h,
      holders: m.holders,
    });
  }
  return { coins, rejected };
}
