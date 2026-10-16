import fs from 'node:fs';
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type TransactionInstruction,
} from '@solana/web3.js';
import {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAccountLen,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import bs58 from 'bs58';
import type { Config } from '../config';

const POLL_MS = 2_000;
/** If we cannot learn the fate of a tx for this long, throw rather than guess. */
const MAX_WAIT_MS = 5 * 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function programId(tokenProgram: string): PublicKey {
  return new PublicKey(tokenProgram);
}

export function createConnection(cfg: Config): Connection {
  return new Connection(cfg.rpcUrl, { commitment: 'confirmed' });
}

/**
 * Load the keeper keypair from cfg.keeperKeypairPath if set; otherwise use cfg.keeperPubkey
 * with signer null. Throws if neither is set.
 */
export function loadKeeper(cfg: Config): { pubkey: PublicKey; signer: Keypair | null } {
  if (cfg.keeperKeypairPath) {
    const raw = JSON.parse(fs.readFileSync(cfg.keeperKeypairPath, 'utf8')) as unknown;
    if (!Array.isArray(raw) || raw.length !== 64 || !raw.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
      throw new Error(`keeper keypair ${cfg.keeperKeypairPath} must be a JSON array of 64 bytes`);
    }
    const signer = Keypair.fromSecretKey(Uint8Array.from(raw as number[]));
    if (cfg.keeperPubkey && cfg.keeperPubkey !== signer.publicKey.toBase58()) {
      throw new Error('KEEPER_PUBKEY does not match the loaded KEEPER_KEYPAIR');
    }
    return { pubkey: signer.publicKey, signer };
  }
  if (cfg.keeperPubkey) return { pubkey: new PublicKey(cfg.keeperPubkey), signer: null };
  throw new Error('config: set KEEPER_KEYPAIR or KEEPER_PUBKEY');
}

export async function getSolBalance(conn: Connection, owner: PublicKey): Promise<bigint> {
  return BigInt(await conn.getBalance(owner, 'confirmed'));
}

/** Raw balance of owner's ATA for mint (0n if the account does not exist). */
export async function getTokenBalanceRaw(
  conn: Connection,
  owner: PublicKey,
  mint: string,
  tokenProgram: string,
): Promise<bigint> {
  const pid = programId(tokenProgram);
  const ata = getAssociatedTokenAddressSync(new PublicKey(mint), owner, true, pid);
  try {
    const bal = await conn.getTokenAccountBalance(ata, 'confirmed');
    return BigInt(bal.value.amount);
  } catch (e) {
    // Account not found / not a token account -> 0. Anything else (transport) propagates.
    const msg = String((e as Error)?.message ?? e);
    if (/could not find account|invalid param|not a token account|account not found/i.test(msg)) return 0n;
    throw e;
  }
}

/** Rent-exempt minimum for a token account (165 bytes; Token-2022 accounts may be larger). */
export async function getAtaRentLamports(conn: Connection, tokenProgram: string): Promise<bigint> {
  // Token-2022 ATAs are created with the ImmutableOwner extension (170 bytes). Mints that would add
  // more account extensions (transfer fee, hook, non-transferable...) are rejected by checkMint.
  const size = tokenProgram === TOKEN_2022_PROGRAM_ID.toBase58() ? getAccountLen([ExtensionType.ImmutableOwner]) : 165;
  return BigInt(await conn.getMinimumBalanceForRentExemption(size));
}

/**
 * Build a v0 transaction with ComputeBudget (price from cfg, explicit unit limit when given),
 * sign it with payer, and return it with its signature (base58) and lastValidBlockHeight.
 * Does NOT send.
 */
export async function buildAndSign(
  conn: Connection,
  cfg: Config,
  payer: Keypair,
  ixs: TransactionInstruction[],
  computeUnitLimit?: number,
): Promise<{ tx: VersionedTransaction; signature: string; lastValidBlockHeight: number }> {
  const budget: TransactionInstruction[] = [];
  if (computeUnitLimit !== undefined) {
    budget.push(ComputeBudgetProgram.setComputeUnitLimit({ units: Math.ceil(computeUnitLimit) }));
  }
  if (cfg.priorityFeeMicroLamports > 0) {
    budget.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Math.round(cfg.priorityFeeMicroLamports) }));
  }
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [...budget, ...ixs],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([payer]);
  return { tx, signature: signatureOf(tx), lastValidBlockHeight };
}

/** Signature (base58) of an already-signed transaction. */
export function signatureOf(tx: VersionedTransaction): string {
  const sig = tx.signatures[0];
  if (!sig) throw new Error('transaction has no signatures');
  return bs58.encode(sig);
}

/**
 * Send a signed transaction and wait for 'confirmed', re-broadcasting every ~2s until
 * the block height passes lastValidBlockHeight.
 * Returns 'confirmed' | 'failed' (landed with an error) | 'expired' (never landed).
 */
export async function sendAndConfirm(
  conn: Connection,
  tx: VersionedTransaction,
  lastValidBlockHeight: number,
): Promise<'confirmed' | 'failed' | 'expired'> {
  const signature = signatureOf(tx);
  const raw = tx.serialize();
  const started = Date.now();

  const broadcast = async (): Promise<'failed' | null> => {
    try {
      await conn.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 0, preflightCommitment: 'confirmed' });
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      // Benign: already seen / blockhash lag on a lagging RPC node. Keep polling.
      if (/already (been )?processed|blockhash not found|node is behind|timed? ?out|fetch failed|429|50\d/i.test(msg)) {
        return null;
      }
      // Preflight simulation rejected it: it can never land successfully.
      if (/simulation failed|custom program error|insufficient|instruction \d+|0x[0-9a-f]+/i.test(msg)) {
        // It may still have landed through an earlier broadcast; the status check below decides.
        return 'failed';
      }
      return null;
    }
    return null;
  };

  const check = async (history: boolean): Promise<'confirmed' | 'failed' | null> => {
    const { value } = await conn.getSignatureStatuses([signature], { searchTransactionHistory: history });
    const st = value[0];
    if (!st) return null;
    if (st.err) return 'failed';
    if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') return 'confirmed';
    return null;
  };

  const first = await broadcast();
  if (first === 'failed') {
    // Make sure it did not land anyway before reporting failure.
    const landed = await check(true).catch(() => null);
    return landed ?? 'failed';
  }

  for (;;) {
    await sleep(POLL_MS);
    try {
      const status = await check(false);
      if (status) return status;
      const height = await conn.getBlockHeight('confirmed');
      if (height > lastValidBlockHeight) {
        // Final look (with history) in case it landed in the very last slots.
        const last = await check(true);
        return last ?? 'expired';
      }
      await broadcast();
    } catch {
      // transient RPC trouble: keep going until the wall-clock cap
    }
    if (Date.now() - started > MAX_WAIT_MS) {
      throw new Error(`sendAndConfirm: could not determine status of ${signature} within ${MAX_WAIT_MS / 1000}s`);
    }
  }
}

/**
 * Status of a signature we may have sent before a crash (searchTransactionHistory: true).
 * 'unknown' = not found; caller decides whether it is expired using lastValidBlockHeight.
 */
export async function signatureStatus(
  conn: Connection,
  signature: string,
): Promise<'confirmed' | 'failed' | 'unknown'> {
  const { value } = await conn.getSignatureStatuses([signature], { searchTransactionHistory: true });
  const st = value[0];
  if (!st) return 'unknown';
  if (st.err) return 'failed';
  if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') return 'confirmed';
  return 'unknown'; // processed only: not yet safe to treat as landed
}

export async function getBlockHeight(conn: Connection): Promise<number> {
  return conn.getBlockHeight('confirmed');
}

/**
 * Change in `owner`'s balance of `mint` caused by a confirmed transaction, from
 * meta.preTokenBalances/postTokenBalances (all of owner's accounts for that mint summed).
 * Also returns the lamports the owner spent (pre - post SOL balance of the owner, fee included).
 */
export async function getTxBalanceDelta(
  conn: Connection,
  signature: string,
  owner: string,
  mint: string,
): Promise<{ tokenDeltaRaw: bigint; lamportsSpent: bigint }> {
  const res = await conn.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
  if (!res || !res.meta) throw new Error(`getTxBalanceDelta: transaction ${signature} not found`);
  const meta = res.meta;
  const sum = (list: typeof meta.preTokenBalances) =>
    (list ?? [])
      .filter((b) => b.owner === owner && b.mint === mint)
      .reduce((acc, b) => acc + BigInt(b.uiTokenAmount.amount), 0n);
  const tokenDeltaRaw = sum(meta.postTokenBalances) - sum(meta.preTokenBalances);

  const keys = res.transaction.message.getAccountKeys({ accountKeysFromLookups: meta.loadedAddresses });
  let idx = -1;
  for (let i = 0; i < keys.length; i++) {
    if (keys.get(i)?.toBase58() === owner) {
      idx = i;
      break;
    }
  }
  let lamportsSpent = 0n;
  if (idx >= 0) {
    lamportsSpent = BigInt(meta.preBalances[idx] ?? 0) - BigInt(meta.postBalances[idx] ?? 0);
  }
  return { tokenDeltaRaw, lamportsSpent };
}

export { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID };
