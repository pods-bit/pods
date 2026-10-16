import { z } from 'zod';
import type { Config } from '../config';
import type { PodMarket } from '../../../shared/types';

const POD_ORIGIN = 'https://orcapod.fun';

const num = z.number().finite();
const numOrZero = num.nullish().transform((v) => v ?? 0);

/** Only the fields we need; everything else in Pod's rows is ignored. */
const RowSchema = z.object({
  mint: z.string().min(32).max(44),
  pool: z.string().min(32).max(44),
  symbol: z.string(),
  name: z.string(),
  image: z.string().nullish().transform((v) => v ?? ''),
  quoteMint: z.string().min(32).max(44),
  quoteTicker: z.string().nullish().transform((v) => v ?? ''),
  quoteUsd: num,
  priceUsd: num,
  marketCapUsd: num,
  quoteReserve: num,
  volume24hUsd: numOrZero,
  trades24h: numOrZero,
  holders: numOrZero,
  change24h: numOrZero,
  createdAt: num,
  suspect: z.boolean().nullish().transform((v) => v ?? false),
  paused: z.boolean().nullish().transform((v) => v ?? false),
});

export function absoluteImageUrl(image: string): string {
  if (!image) return '';
  if (/^https?:\/\//i.test(image)) return image;
  return POD_ORIGIN + (image.startsWith('/') ? image : `/${image}`);
}

/** Normalise one raw Pod row; null when malformed. Exported for tests. */
export function normaliseMarket(row: unknown): PodMarket | null {
  const r = RowSchema.safeParse(row);
  if (!r.success) return null;
  const d = r.data;
  return {
    mint: d.mint,
    pool: d.pool,
    symbol: d.symbol,
    name: d.name,
    image: absoluteImageUrl(d.image),
    quoteMint: d.quoteMint,
    quoteTicker: d.quoteTicker,
    quoteUsd: d.quoteUsd,
    priceUsd: d.priceUsd,
    marketCapUsd: d.marketCapUsd,
    liquidityUsd: d.quoteReserve * d.quoteUsd,
    volume24hUsd: d.volume24hUsd,
    trades24h: d.trades24h,
    holders: d.holders,
    change24h: d.change24h,
    createdAt: d.createdAt,
    suspect: d.suspect,
    paused: d.paused,
  };
}

/**
 * GET `${cfg.podApiBase}/markets` and normalise every coin into PodMarket.
 * - Validate with zod; skip (and do not throw on) individual malformed rows.
 * - liquidityUsd = quoteReserve * quoteUsd.
 * - image: Pod returns relative paths like "/img/..."; make them absolute against https://orcapod.fun.
 * - Throw on HTTP errors / non-JSON so the round can skip cleanly.
 */
export async function fetchMarkets(cfg: Config): Promise<PodMarket[]> {
  const url = `${cfg.podApiBase.replace(/\/+$/, '')}/markets`;
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`pod: GET ${url} -> HTTP ${res.status}`);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error(`pod: GET ${url} returned non-JSON`);
  }
  const rows = (body as { markets?: unknown } | null)?.markets;
  if (!Array.isArray(rows)) throw new Error('pod: response has no "markets" array');
  const out: PodMarket[] = [];
  for (const row of rows) {
    const m = normaliseMarket(row);
    if (m) out.push(m);
  }
  return out;
}
