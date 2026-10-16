import { PublicKey, type TransactionInstruction, type VersionedTransaction } from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import type { KeeperContext } from '../context';
import type { DeliveryItem } from '../ledger/db';
import { alert } from '../log';
import { deliveryDecision } from './plan';
import { EXPIRY_MARGIN_BLOCKS, settleSignature } from './buy';
import { getOwnersWithAta } from '../chain/holders';
import {
  buildAndSign,
  getAtaRentLamports,
  getBlockHeight,
  getSolBalance,
  getTokenBalanceRaw,
  sendAndConfirm,
  signatureStatus,
} from '../chain/rpc';

/** Solana packet limit for a serialized transaction. */
export const MAX_TX_BYTES = 1232;
const CU_PER_TRANSFER = 15_000;
const CU_PER_OPEN = 50_000; // idempotent ATA create (+ Token-2022 headroom) + transfer
const CU_BASE = 10_000;
const CU_MAX = 1_400_000;

export interface DeliveryCoin {
  mint: string;
  decimals: number;
  tokenProgram: string;
  priceUsd: number;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isSizeError(e: unknown): boolean {
  const m = errMsg(e);
  return e instanceof RangeError || /overrun|too large|exceed|size/i.test(m);
}

/** Instructions for one delivery batch. Exported for tests. */
export function buildDeliveryIxs(
  keeper: PublicKey,
  coin: DeliveryCoin,
  items: DeliveryItem[],
  open: boolean,
): TransactionInstruction[] {
  const mint = new PublicKey(coin.mint);
  const program = new PublicKey(coin.tokenProgram);
  const source = getAssociatedTokenAddressSync(mint, keeper, false, program);
  const ixs: TransactionInstruction[] = [];
  for (const it of items) {
    const owner = new PublicKey(it.wallet);
    const dest = getAssociatedTokenAddressSync(mint, owner, true, program);
    if (open) {
      ixs.push(createAssociatedTokenAccountIdempotentInstruction(keeper, dest, owner, mint, program));
    }
    ixs.push(
      createTransferCheckedInstruction(source, mint, dest, keeper, it.amountRaw, coin.decimals, [], program),
    );
  }
  return ixs;
}

/**
 * Deliver owed balances of one coin to every wallet (all rounds, not just this one).
 * For each wallet with owed > 0: deliveryDecision(...) using getOwnersWithAta.
 * Batch 'send' items (cfg.transfersPerTx per tx) and 'open' items (cfg.ataCreatesPerTx per tx,
 * createAssociatedTokenAccountIdempotent + transferChecked, keeper pays rent).
 * Per tx (crash-safe): buildAndSign -> ledger.recordPendingDelivery -> sendAndConfirm ->
 * confirmDelivery | failDelivery. Stops early (returns) if keeper SOL drops below opReserve.
 *
 * Additional guarantees:
 * - Never sends in dry-run / without a signer.
 * - Skips the mint entirely while an earlier delivery tx for it is still unsettled
 *   (its owed entries are not yet decremented, so re-sending could double-pay).
 * - Never transfers more than the keeper's on-chain balance of the mint (alerts on shortfall).
 * - Batches that do not fit in MAX_TX_BYTES are halved until they do.
 * - A failed/expired tx is recorded (failDelivery) and stops this mint for this round.
 * - A transport error while sending leaves the tx pending and is rethrown.
 */
export async function deliverMint(
  ctx: KeeperContext,
  roundId: number,
  coin: { mint: string; decimals: number; tokenProgram: string; priceUsd: number },
  solUsd: number,
): Promise<{ transfers: number; signatures: string[] }> {
  const out = { transfers: 0, signatures: [] as string[] };
  const { cfg, ledger, log, conn } = ctx;
  if (ctx.dryRun || !ctx.signer) return out;
  const signer = ctx.signer;

  if (ledger.getPendingDeliveries().some((p) => p.mint === coin.mint)) {
    log.warn('delivery skipped: earlier tx for this mint still unsettled', { mint: coin.mint });
    return out;
  }

  const owed = ledger.getOwedForMint(coin.mint);
  if (owed.size === 0) return out;

  const owners = [...owed.keys()];
  const withAta = await getOwnersWithAta(conn, coin.mint, coin.tokenProgram, owners);
  const rentLamports = await getAtaRentLamports(conn, coin.tokenProgram);

  const sends: DeliveryItem[] = [];
  const opens: DeliveryItem[] = [];
  let waiting = 0;
  for (const [wallet, owedRaw] of owed) {
    if (owedRaw <= 0n) continue;
    const d = deliveryDecision({
      owedRaw,
      hasAta: withAta.has(wallet),
      tokenPriceUsd: coin.priceUsd,
      decimals: coin.decimals,
      solUsd,
      rentLamports,
      rentMargin: cfg.rentMargin,
    });
    if (d.kind === 'send' && d.amountRaw > 0n) {
      sends.push({ wallet, amountRaw: d.amountRaw, rentWithheldRaw: 0n });
    } else if (d.kind === 'open' && d.amountRaw > 0n) {
      opens.push({ wallet, amountRaw: d.amountRaw, rentWithheldRaw: d.rentWithheldRaw });
    } else {
      waiting++;
    }
  }
  const byAmountDesc = (a: DeliveryItem, b: DeliveryItem) =>
    a.amountRaw === b.amountRaw ? (a.wallet < b.wallet ? -1 : 1) : a.amountRaw > b.amountRaw ? -1 : 1;
  sends.sort(byAmountDesc);
  opens.sort(byAmountDesc);
  log.info('delivery plan', { mint: coin.mint, send: sends.length, open: opens.length, wait: waiting });
  if (sends.length === 0 && opens.length === 0) return out;

  // Never try to move more than the keeper actually holds.
  let tokenBudget = await getTokenBalanceRaw(conn, ctx.keeper, coin.mint, coin.tokenProgram);
  const wanted = [...sends, ...opens].reduce((s, it) => s + it.amountRaw, 0n);
  if (wanted > tokenBudget) {
    const msg = `ledger wants to deliver ${wanted} raw of ${coin.mint} but keeper holds ${tokenBudget}`;
    log.error(msg);
    await alert(cfg, msg);
  }
  const fitBudget = (items: DeliveryItem[]): DeliveryItem[] => {
    const kept: DeliveryItem[] = [];
    for (const it of items) {
      if (it.amountRaw <= tokenBudget) {
        kept.push(it);
        tokenBudget -= it.amountRaw;
      }
    }
    return kept;
  };
  const queues: Array<{ items: DeliveryItem[]; open: boolean; perTx: number }> = [
    { items: fitBudget(sends), open: false, perTx: Math.max(1, Math.floor(cfg.transfersPerTx)) },
    { items: fitBudget(opens), open: true, perTx: Math.max(1, Math.floor(cfg.ataCreatesPerTx)) },
  ];

  for (const q of queues) {
    let i = 0;
    let perTx = q.perTx;
    while (i < q.items.length) {
      let batch = q.items.slice(i, i + perTx);

      const sol = await getSolBalance(conn, ctx.keeper);
      const needed = cfg.opReserveLamports + (q.open ? rentLamports * BigInt(batch.length) : 0n);
      if (sol < needed) {
        if (q.open && sol >= cfg.opReserveLamports + rentLamports) {
          // Can still afford some account rents: shrink the batch to what fits.
          const n = Number((sol - cfg.opReserveLamports) / rentLamports);
          batch = batch.slice(0, Math.max(1, n));
        } else {
          log.warn('delivery stopped: keeper SOL below operating reserve', {
            mint: coin.mint,
            sol,
            needed,
          });
          return out;
        }
      }

      // Build + sign, halving the batch until it fits in one packet.
      let built: { tx: VersionedTransaction; signature: string; lastValidBlockHeight: number } | null = null;
      while (!built) {
        const ixs = buildDeliveryIxs(ctx.keeper, coin, batch, q.open);
        const cu = Math.min(CU_MAX, CU_BASE + batch.length * (q.open ? CU_PER_OPEN : CU_PER_TRANSFER));
        let tooBig = false;
        try {
          const b = await buildAndSign(conn, cfg, signer, ixs, cu);
          if (b.tx.serialize().length > MAX_TX_BYTES) tooBig = true;
          else built = b;
        } catch (e) {
          if (!isSizeError(e)) throw e;
          tooBig = true;
        }
        if (tooBig) {
          if (batch.length === 1) throw new Error(`a single delivery to ${batch[0]!.wallet} does not fit in a transaction`);
          batch = batch.slice(0, Math.ceil(batch.length / 2));
          perTx = Math.min(perTx, batch.length); // remember for the rest of this queue
        }
      }

      // Record BEFORE broadcasting: owed is only decremented once the tx is confirmed.
      ledger.recordPendingDelivery({
        signature: built.signature,
        roundId,
        mint: coin.mint,
        lastValidBlockHeight: built.lastValidBlockHeight,
        items: batch,
      });
      let result: 'confirmed' | 'failed' | 'expired' | 'unknown' = await sendAndConfirm(
        conn,
        built.tx,
        built.lastValidBlockHeight,
      ); // throws -> stays pending
      if (result === 'expired') {
        // Re-check after a safety margin: failing a tx that landed late would double-pay later.
        result = await settleSignature(ctx, built.signature, built.lastValidBlockHeight);
      }
      if (result === 'unknown') {
        log.warn('delivery tx outcome unknown; left pending for resumeDeliveries', { mint: coin.mint, signature: built.signature });
        return out;
      }
      if (result === 'confirmed') {
        ledger.confirmDelivery(built.signature);
        out.transfers += batch.length;
        out.signatures.push(built.signature);
        log.info('delivery confirmed', { mint: coin.mint, items: batch.length, open: q.open, signature: built.signature });
      } else {
        ledger.failDelivery(built.signature, result);
        log.warn('delivery tx did not confirm; owed kept for next round', {
          mint: coin.mint,
          signature: built.signature,
          result,
        });
        return out;
      }
      i += batch.length;
    }
  }
  return out;
}

/** After a crash: settle every pending delivery tx (confirmed -> confirm; failed/expired -> fail). */
export async function resumeDeliveries(ctx: KeeperContext): Promise<void> {
  if (ctx.dryRun) return;
  const pending = ctx.ledger.getPendingDeliveries();
  if (pending.length === 0) return;
  // Height first: once past lastValidBlockHeight (+ margin), an 'unknown' status read after is final.
  const height = await getBlockHeight(ctx.conn);
  for (const p of pending) {
    const status = await signatureStatus(ctx.conn, p.signature);
    if (status === 'confirmed') {
      ctx.ledger.confirmDelivery(p.signature);
      ctx.log.info('resumed delivery confirmed', { signature: p.signature, mint: p.mint, items: p.items.length });
    } else if (status === 'failed') {
      ctx.ledger.failDelivery(p.signature, 'failed');
      ctx.log.warn('resumed delivery failed on-chain', { signature: p.signature, mint: p.mint });
    } else if (height > p.lastValidBlockHeight + EXPIRY_MARGIN_BLOCKS) {
      ctx.ledger.failDelivery(p.signature, 'expired');
      ctx.log.warn('resumed delivery expired', { signature: p.signature, mint: p.mint });
    } else {
      ctx.log.warn('delivery still unsettled; will retry', { signature: p.signature, mint: p.mint });
    }
  }
}
