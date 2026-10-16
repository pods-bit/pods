import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WSOL_MINT } from './config';
import type { KeeperContext } from './context';
import { getSolBalance } from './chain/rpc';
import { getPricesUsd } from './sources/jupiter';
import type { BasketCoin, PublicState, RejectedCoin } from '../../shared/types';

/** Ledger meta key holding the most recent live basket selection ({basket, rejected}). */
export const META_LAST_SELECTION = 'last_selection';

export function toJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, path);
}

function lastSelection(ctx: KeeperContext): { basket: BasketCoin[]; rejected: RejectedCoin[] } | null {
  const raw = ctx.ledger.getMeta(META_LAST_SELECTION);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { basket?: BasketCoin[]; rejected?: RejectedCoin[] };
    return { basket: v.basket ?? [], rejected: v.rejected ?? [] };
  } catch {
    return null;
  }
}

/** Build the PublicState object (exported for tests). Tolerates an empty ledger. */
export interface LiveFigures {
  keeperLamports: bigint | null;
  solUsd: number | null;
  pod5PriceUsd: number | null;
}

/** Best-effort live numbers for the site; any failure becomes null, never an error. */
export async function readLiveFigures(ctx: KeeperContext): Promise<LiveFigures> {
  const out: LiveFigures = { keeperLamports: null, solUsd: null, pod5PriceUsd: null };
  try {
    out.keeperLamports = await getSolBalance(ctx.conn, ctx.keeper);
  } catch (e) {
    ctx.log.warn('publish: keeper balance unavailable', { error: String(e) });
  }
  try {
    const mints = [WSOL_MINT, ...(ctx.cfg.pod5Mint ? [ctx.cfg.pod5Mint] : [])];
    const px = await getPricesUsd(ctx.cfg, mints);
    out.solUsd = px[WSOL_MINT] ?? null;
    out.pod5PriceUsd = ctx.cfg.pod5Mint ? px[ctx.cfg.pod5Mint] ?? null : null;
  } catch (e) {
    ctx.log.warn('publish: prices unavailable', { error: String(e) });
  }
  return out;
}

export function buildPublicState(
  ctx: KeeperContext,
  preview?: { basket: BasketCoin[]; rejected: RejectedCoin[] },
  live?: LiveFigures,
): PublicState {
  const { cfg, ledger } = ctx;
  const rounds = ledger.listRounds(50);

  let selection = preview ?? lastSelection(ctx);
  if (!selection) {
    selection = { basket: [], rejected: [] };
    for (const r of rounds) {
      const b = ledger.getRoundBasket(r.id);
      if (b.length > 0) {
        selection = { basket: b, rejected: [] };
        break;
      }
    }
  }

  const t = ledger.totals();
  return {
    updatedAt: ctx.now(),
    cluster: cfg.cluster,
    pod5Mint: cfg.pod5Mint ?? '',
    keeperWallet: ctx.keeper.toBase58(),
    keeperLamports: live?.keeperLamports != null ? live.keeperLamports.toString() : null,
    solUsd: live?.solUsd ?? null,
    pod5PriceUsd: live?.pod5PriceUsd ?? null,
    intervalMin: cfg.roundIntervalMin,
    minHoldUsd: cfg.minHoldUsd,
    maxCoins: cfg.maxCoins,
    basket: selection.basket,
    rejected: selection.rejected,
    rounds,
    totals: {
      rounds: t.rounds,
      roundsRun: t.roundsRun,
      spentLamports: t.spentLamports.toString(),
      transfersSent: t.transfersSent,
      walletsPaid: t.walletsPaid,
    },
  };
}

/**
 * Write `${cfg.publishDir}/state.json` (PublicState) and `${cfg.publishDir}/owed.json`
 * (OwedSnapshot) atomically (write temp file, rename). `preview` overrides the basket/rejected
 * lists (used after dry-runs); otherwise use the basket of the most recent round.
 * Bigints are serialised as decimal strings.
 */
export async function publishState(
  ctx: KeeperContext,
  preview?: { basket: BasketCoin[]; rejected: RejectedCoin[] },
): Promise<void> {
  const dir = ctx.cfg.publishDir;
  await mkdir(dir, { recursive: true });
  const state = buildPublicState(ctx, preview, await readLiveFigures(ctx));
  const owed = ctx.ledger.owedSnapshot(ctx.now());
  await writeAtomic(join(dir, 'state.json'), toJson(state));
  await writeAtomic(join(dir, 'owed.json'), toJson(owed));
}
