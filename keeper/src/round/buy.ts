import { WSOL_MINT } from '../config';
import type { KeeperContext } from '../context';
import type { BuyRow } from '../ledger/db';
import { buildSwapTransaction, getQuoteMeasured } from '../sources/jupiter';
import {
  getBlockHeight,
  getTxBalanceDelta,
  sendAndConfirm,
  signatureOf,
  signatureStatus,
} from '../chain/rpc';
import type { BasketCoin, RoundBuyReceipt } from '../../../shared/types';

/** Thrown when a buy was broadcast but its outcome is not known yet (resumeBuy settles it later). */
export class BuyUnsettledError extends Error {
  constructor(
    public readonly mint: string,
    public readonly signature: string,
    cause?: unknown,
  ) {
    super(
      `buy of ${mint} (${signature}) was sent but is not settled yet` +
        (cause ? `: ${errMsg(cause)}` : ''),
    );
    this.name = 'BuyUnsettledError';
  }
}

/**
 * Blocks past lastValidBlockHeight before an unseen signature is treated as expired. RPC
 * signatureStatus reports 'processed' as unknown, so a tx processed right at the expiry height
 * may still confirm a little later; this margin keeps us from failing (and later re-sending)
 * a transaction that actually landed.
 */
export const EXPIRY_MARGIN_BLOCKS = 150;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Final outcome of a signature whose blockhash has (nearly) expired: polls until the chain
 * height is past lastValidBlockHeight + EXPIRY_MARGIN_BLOCKS. 'unknown' only if maxWaitMs ran out.
 */
export async function settleSignature(
  ctx: KeeperContext,
  signature: string,
  lastValidBlockHeight: number,
  opts: { pollMs?: number; maxWaitMs?: number } = {},
): Promise<'confirmed' | 'failed' | 'expired' | 'unknown'> {
  const pollMs = opts.pollMs ?? 5_000;
  const maxWaitMs = opts.maxWaitMs ?? 180_000;
  const started = Date.now();
  for (;;) {
    // Height first: past the margin, a status read afterwards that is still unknown is final.
    const height = await getBlockHeight(ctx.conn);
    const status = await signatureStatus(ctx.conn, signature);
    if (status !== 'unknown') return status;
    if (height > lastValidBlockHeight + EXPIRY_MARGIN_BLOCKS) return 'expired';
    if (Date.now() - started > maxWaitMs) return 'unknown';
    await sleep(pollMs);
  }
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function receiptOf(row: BuyRow): RoundBuyReceipt {
  const r: RoundBuyReceipt = {
    mint: row.mint,
    symbol: row.symbol,
    decimals: row.decimals,
    spentLamports: row.spentLamports.toString(),
    receivedRaw: row.receivedRaw.toString(),
    signature: row.signature,
  };
  if (row.error) r.error = row.error;
  return r;
}

function findBuy(ctx: KeeperContext, roundId: number, mint: string): BuyRow | undefined {
  return ctx.ledger.getBuys(roundId).find((b) => b.mint === mint);
}

/**
 * Buy `coin` with `lamports` SOL via Jupiter for round `roundId`.
 * Re-quotes; refuses (receipt.error, no send) if no route or priceImpactBps > cfg.maxImpactBps.
 * Order (crash-safe): build+sign -> ledger.upsertBuy(state SENT, signature, lastValidBlockHeight)
 * -> sendAndConfirm -> on confirmed: receivedRaw/spent from getTxBalanceDelta -> state CONFIRMED.
 * Idempotent: if a CONFIRMED buy row already exists for (roundId, mint), return it.
 *
 * Additional guarantees:
 * - Never sends in dry-run or without a signer (returns an error receipt, writes nothing).
 * - An existing FAILED row is returned as-is (a slice is attempted at most once per round).
 * - An existing SENT row is settled from chain state (resumeBuy), never re-sent.
 * - Errors before the tx is recorded as SENT are recorded as FAILED (nothing left the wallet).
 * - If the outcome of a sent tx is unknown (transport error), the row stays SENT and
 *   BuyUnsettledError is thrown so the caller leaves the round for resumePending.
 */
export async function executeBuy(
  ctx: KeeperContext,
  roundId: number,
  coin: BasketCoin,
  lamports: bigint,
): Promise<RoundBuyReceipt> {
  const { cfg, ledger, log } = ctx;
  const base = {
    roundId,
    mint: coin.mint,
    symbol: coin.symbol,
    decimals: coin.decimals,
    tokenProgram: coin.tokenProgram,
  };
  const refuse = (error: string): RoundBuyReceipt => ({
    mint: coin.mint,
    symbol: coin.symbol,
    decimals: coin.decimals,
    spentLamports: '0',
    receivedRaw: '0',
    signature: null,
    error,
  });

  if (ctx.dryRun || !ctx.signer) {
    return refuse(ctx.dryRun ? 'dry-run: not sent' : 'no signer: not sent');
  }
  const signer = ctx.signer;

  const existing = findBuy(ctx, roundId, coin.mint);
  if (existing) {
    if (existing.state === 'CONFIRMED' || existing.state === 'FAILED') return receiptOf(existing);
    if (existing.state === 'SENT') {
      await resumeBuy(ctx, existing);
      const after = findBuy(ctx, roundId, coin.mint)!;
      if (after.state === 'SENT') throw new BuyUnsettledError(coin.mint, after.signature ?? '?');
      return receiptOf(after);
    }
    // PENDING without a signature: nothing was broadcast; fall through and attempt it.
  }

  const failNoSend = (error: string): RoundBuyReceipt => {
    ledger.upsertBuy({
      ...base,
      spentLamports: 0n,
      receivedRaw: 0n,
      state: 'FAILED',
      signature: null,
      lastValidBlockHeight: null,
      error,
    });
    log.warn('buy refused', { roundId, mint: coin.mint, symbol: coin.symbol, error });
    return refuse(error);
  };

  if (lamports <= 0n) return failNoSend('slice is zero');

  // ---- quote + build + sign: nothing leaves the wallet in this block ----
  let signed: { tx: Parameters<typeof signatureOf>[0]; signature: string; lastValidBlockHeight: number };
  try {
    const quote = await getQuoteMeasured(cfg, {
      inputMint: WSOL_MINT,
      outputMint: coin.mint,
      amount: lamports,
      slippageBps: cfg.slippageBps,
    });
    if (!quote) return failNoSend('no Jupiter route');
    if (quote.priceImpactBps > cfg.maxImpactBps) {
      return failNoSend(`price impact ${quote.priceImpactBps} bps > max ${cfg.maxImpactBps} bps`);
    }
    if (quote.inAmount > lamports) {
      return failNoSend(`quote inAmount ${quote.inAmount} exceeds slice ${lamports}`);
    }
    const { tx, lastValidBlockHeight } = await buildSwapTransaction(cfg, quote, ctx.keeper.toBase58());
    const payer = tx.message.staticAccountKeys[0];
    if (!payer || !payer.equals(ctx.keeper)) {
      return failNoSend(`swap tx fee payer ${payer?.toBase58() ?? 'none'} is not the keeper`);
    }
    tx.sign([signer]);
    signed = { tx, signature: signatureOf(tx), lastValidBlockHeight };
  } catch (e) {
    return failNoSend(`swap build failed: ${errMsg(e)}`);
  }

  // ---- record BEFORE broadcasting so a crash can never cause a double buy ----
  ledger.upsertBuy({
    ...base,
    spentLamports: lamports,
    receivedRaw: 0n,
    state: 'SENT',
    signature: signed.signature,
    lastValidBlockHeight: signed.lastValidBlockHeight,
    error: null,
  });
  log.info('buy sent', { roundId, mint: coin.mint, symbol: coin.symbol, lamports, signature: signed.signature });

  let result: 'confirmed' | 'failed' | 'expired';
  try {
    result = await sendAndConfirm(ctx.conn, signed.tx, signed.lastValidBlockHeight);
  } catch (e) {
    // The tx may or may not land. Keep SENT; resumeBuy decides from chain state.
    throw new BuyUnsettledError(coin.mint, signed.signature, e);
  }

  if (result === 'expired') {
    // Double-check after a safety margin: a late confirmation must be credited, not dropped.
    const final = await settleSignature(ctx, signed.signature, signed.lastValidBlockHeight);
    if (final === 'unknown') throw new BuyUnsettledError(coin.mint, signed.signature);
    result = final;
  }

  if (result !== 'confirmed') {
    const error = result === 'failed' ? 'swap failed on-chain' : 'swap expired (never landed)';
    ledger.upsertBuy({
      ...base,
      spentLamports: 0n,
      receivedRaw: 0n,
      state: 'FAILED',
      signature: signed.signature,
      lastValidBlockHeight: signed.lastValidBlockHeight,
      error,
    });
    log.warn('buy failed', { roundId, mint: coin.mint, signature: signed.signature, error });
    return receiptOf(findBuy(ctx, roundId, coin.mint)!);
  }

  try {
    await markConfirmed(ctx, { ...base, signature: signed.signature, lastValidBlockHeight: signed.lastValidBlockHeight });
  } catch (e) {
    // Landed, but we could not read the balance delta. Stays SENT; resumeBuy re-reads it.
    throw new BuyUnsettledError(coin.mint, signed.signature, e);
  }
  return receiptOf(findBuy(ctx, roundId, coin.mint)!);
}

async function markConfirmed(
  ctx: KeeperContext,
  b: Pick<BuyRow, 'roundId' | 'mint' | 'symbol' | 'decimals' | 'tokenProgram' | 'signature' | 'lastValidBlockHeight'>,
): Promise<void> {
  const delta = await getTxBalanceDelta(ctx.conn, b.signature!, ctx.keeper.toBase58(), b.mint);
  let received = delta.tokenDeltaRaw;
  if (received < 0n) {
    ctx.log.error('confirmed buy has negative token delta; crediting 0', { mint: b.mint, signature: b.signature, delta: received });
    received = 0n;
  }
  ctx.ledger.upsertBuy({
    ...b,
    spentLamports: delta.lamportsSpent > 0n ? delta.lamportsSpent : 0n,
    receivedRaw: received,
    state: 'CONFIRMED',
    error: null,
  });
  ctx.log.info('buy confirmed', { roundId: b.roundId, mint: b.mint, receivedRaw: received, spentLamports: delta.lamportsSpent, signature: b.signature });
}

/**
 * After a crash: settle a SENT buy row by looking up its signature on-chain.
 * confirmed -> CONFIRMED (amounts from the tx's balance delta); failed -> FAILED;
 * not found and the blockhash has expired -> FAILED; not found but still valid -> left SENT.
 */
export async function resumeBuy(ctx: KeeperContext, row: BuyRow): Promise<void> {
  if (ctx.dryRun) return;
  if (row.state !== 'SENT') return;
  const { ledger, log } = ctx;
  const base = {
    roundId: row.roundId,
    mint: row.mint,
    symbol: row.symbol,
    decimals: row.decimals,
    tokenProgram: row.tokenProgram,
    signature: row.signature,
    lastValidBlockHeight: row.lastValidBlockHeight,
  };
  if (!row.signature) {
    // Cannot happen with executeBuy (signature is recorded with SENT), but never guess.
    ledger.upsertBuy({ ...base, spentLamports: 0n, receivedRaw: 0n, state: 'FAILED', error: 'SENT row without signature' });
    return;
  }
  // Read the height BEFORE the status: once the height is past lastValidBlockHeight (+ margin),
  // the tx can no longer land, so an 'unknown' status read afterwards is final.
  const height = await getBlockHeight(ctx.conn);
  const status = await signatureStatus(ctx.conn, row.signature);
  if (status === 'confirmed') {
    await markConfirmed(ctx, base);
    return;
  }
  if (status === 'failed') {
    ledger.upsertBuy({ ...base, spentLamports: 0n, receivedRaw: 0n, state: 'FAILED', error: 'swap failed on-chain' });
    log.warn('resumed buy failed on-chain', { mint: row.mint, signature: row.signature });
    return;
  }
  if (row.lastValidBlockHeight !== null && height > row.lastValidBlockHeight + EXPIRY_MARGIN_BLOCKS) {
    ledger.upsertBuy({ ...base, spentLamports: 0n, receivedRaw: 0n, state: 'FAILED', error: 'swap expired (never landed)' });
    log.warn('resumed buy expired', { mint: row.mint, signature: row.signature });
    return;
  }
  log.warn('buy still unsettled; will retry', { mint: row.mint, signature: row.signature, height, lastValidBlockHeight: row.lastValidBlockHeight });
}
