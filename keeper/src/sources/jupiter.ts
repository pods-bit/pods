import { VersionedTransaction } from '@solana/web3.js';
import type { Config } from '../config';

export interface JupQuote {
  inputMint: string;
  outputMint: string;
  inAmount: bigint;
  outAmount: bigint;
  /** Jupiter's priceImpactPct converted to basis points (e.g. 0.0123 -> 123). */
  priceImpactBps: number;
  /** The untouched quote response, needed to build the swap. */
  raw: unknown;
}

const TIMEOUT_MS = 20_000;
/** Cap on the priority fee Jupiter may add to a swap (0.002 SOL). */
const MAX_PRIORITY_LAMPORTS = 2_000_000;

function headers(cfg: Config, json = false): Record<string, string> {
  const h: Record<string, string> = { accept: 'application/json' };
  if (json) h['content-type'] = 'application/json';
  if (cfg.jupiterApiKey) h['x-api-key'] = cfg.jupiterApiKey;
  return h;
}

function base(cfg: Config): string {
  return cfg.jupiterApiBase.replace(/\/+$/, '');
}

/**
 * Jupiter's priceImpactPct is a FRACTION string ("0.0123" = 1.23%) -> basis points.
 * (Verified live: a 10 SOL buy into a ~$14k pool returns ~0.046, i.e. 4.6%.)
 */
export function priceImpactToBps(pct: unknown): number {
  const n = typeof pct === 'number' ? pct : Number(pct);
  if (!Number.isFinite(n) || n < 0) return Number.POSITIVE_INFINITY; // unknown -> treat as unsafe
  return n * 10_000;
}

/** GET quote (ExactIn). Returns null when Jupiter has no route. Throws on transport errors. */
export async function getQuote(
  cfg: Config,
  p: { inputMint: string; outputMint: string; amount: bigint; slippageBps: number },
): Promise<JupQuote | null> {
  const qs = new URLSearchParams({
    inputMint: p.inputMint,
    outputMint: p.outputMint,
    amount: p.amount.toString(),
    slippageBps: String(Math.round(p.slippageBps)),
    swapMode: 'ExactIn',
  });
  const url = `${base(cfg)}/swap/v1/quote?${qs}`;
  const res = await fetch(url, { headers: headers(cfg), signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`jupiter: quote returned non-JSON (HTTP ${res.status})`);
  }
  if (!res.ok) {
    const code = String(body?.errorCode ?? '');
    const msg = String(body?.error ?? '');
    // No route / untradable token: a normal "no quote" outcome, not a transport error.
    if (
      res.status === 404 ||
      code === 'COULD_NOT_FIND_ANY_ROUTE' ||
      code === 'TOKEN_NOT_TRADABLE' ||
      /could not find any route|not tradable|no routes? found/i.test(msg)
    ) {
      return null;
    }
    throw new Error(`jupiter: quote HTTP ${res.status}: ${msg || text.slice(0, 200)}`);
  }
  if (!body || typeof body.outAmount !== 'string' || typeof body.inAmount !== 'string') return null;
  const outAmount = BigInt(body.outAmount);
  if (outAmount <= 0n) return null;
  return {
    inputMint: String(body.inputMint),
    outputMint: String(body.outputMint),
    inAmount: BigInt(body.inAmount),
    outAmount,
    priceImpactBps: priceImpactToBps(body.priceImpactPct),
    raw: body,
  };
}

/** Smallest reference trade used to measure our own price impact (0.001 SOL / 0.001 units). */
const MIN_REF_AMOUNT = 1_000_000n;

/** Price impact of trading `amount` vs a 1/50-size reference trade, in bps (never negative). */
export function measuredImpactBps(amount: bigint, out: bigint, refAmount: bigint, refOut: bigint): number {
  if (amount <= 0n || refAmount <= 0n || refOut <= 0n) return Number.POSITIVE_INFINITY;
  // 1 - (out/amount) / (refOut/refAmount), in bps, with bigint math.
  const num = out * refAmount * 10_000n;
  const den = amount * refOut;
  const ratioBps = Number(num / den);
  return Math.max(0, 10_000 - ratioBps);
}

/**
 * Quote `amount`, but replace Jupiter's priceImpactPct with an impact we measure ourselves:
 * how much worse our rate is than a small reference quote. Jupiter's figure carries a
 * constant offset on Pod pools (~5% even for a $1 trade, verified live), which made it useless
 * as a guard. If the reference quote is unavailable, Jupiter's own figure is kept.
 */
export async function getQuoteMeasured(
  cfg: Config,
  p: { inputMint: string; outputMint: string; amount: bigint; slippageBps: number },
): Promise<JupQuote | null> {
  const quote = await getQuote(cfg, p);
  if (!quote) return null;
  let ref = p.amount / 50n;
  if (ref < MIN_REF_AMOUNT) ref = MIN_REF_AMOUNT;
  if (ref >= p.amount) return { ...quote, priceImpactBps: 0 };
  const refQuote = await getQuote(cfg, { ...p, amount: ref }).catch(() => null);
  if (!refQuote) return quote;
  return { ...quote, priceImpactBps: measuredImpactBps(quote.inAmount, quote.outAmount, refQuote.inAmount, refQuote.outAmount) };
}

/**
 * POST swap for `userPublicKey` (wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true,
 * prioritizationFeeLamports set from cfg). Returns the unsigned VersionedTransaction.
 */
export async function buildSwapTransaction(
  cfg: Config,
  quote: JupQuote,
  userPublicKey: string,
): Promise<{ tx: VersionedTransaction; lastValidBlockHeight: number }> {
  const url = `${base(cfg)}/swap/v1/swap`;
  const res = await fetch(url, {
    method: 'POST',
    headers: headers(cfg, true),
    body: JSON.stringify({
      quoteResponse: quote.raw,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      // Let Jupiter pick a landing-friendly fee for the writable accounts, bounded by a cap.
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: {
          maxLamports: MAX_PRIORITY_LAMPORTS,
          priorityLevel: 'high',
        },
      },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`jupiter: swap returned non-JSON (HTTP ${res.status})`);
  }
  if (!res.ok) throw new Error(`jupiter: swap HTTP ${res.status}: ${body?.error ?? text.slice(0, 200)}`);
  if (typeof body?.swapTransaction !== 'string') throw new Error('jupiter: swap response missing swapTransaction');
  if (body.simulationError) {
    throw new Error(`jupiter: swap simulation error: ${JSON.stringify(body.simulationError)}`);
  }
  const lastValidBlockHeight = Number(body.lastValidBlockHeight);
  if (!Number.isFinite(lastValidBlockHeight)) throw new Error('jupiter: swap response missing lastValidBlockHeight');
  const tx = VersionedTransaction.deserialize(Buffer.from(body.swapTransaction, 'base64'));
  return { tx, lastValidBlockHeight };
}

/** USD prices for the given mints (Jupiter Price API). Missing mints are omitted. */
export async function getPricesUsd(cfg: Config, mints: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const unique = [...new Set(mints)];
  for (let i = 0; i < unique.length; i += 50) {
    const chunk = unique.slice(i, i + 50);
    const url = `${base(cfg)}/price/v3?ids=${chunk.join(',')}`;
    const res = await fetch(url, { headers: headers(cfg), signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`jupiter: price HTTP ${res.status}`);
    const body = (await res.json()) as Record<string, { usdPrice?: unknown } | null>;
    for (const [mint, v] of Object.entries(body ?? {})) {
      const price = typeof v?.usdPrice === 'number' ? v.usdPrice : Number(v?.usdPrice);
      if (Number.isFinite(price) && price > 0) out[mint] = price;
    }
  }
  return out;
}
