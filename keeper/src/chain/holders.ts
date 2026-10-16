import { PublicKey, type Connection } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import type { Holder } from '../round/plan';

/** Parse a 40-byte dataSlice (owner[32] | amount u64 LE[8]). Exported for tests. */
export function parseSlice(data: Uint8Array): { owner: Uint8Array; amount: bigint } | null {
  if (data.length < 40) return null;
  const owner = data.slice(0, 32);
  const dv = new DataView(data.buffer, data.byteOffset + 32, 8);
  return { owner, amount: dv.getBigUint64(0, true) };
}

/**
 * Every wallet holding `mint`: getProgramAccounts on tokenProgram filtered by mint
 * (memcmp offset 0; dataSize 165 for classic SPL Token), summing balances per owner.
 * Drops: zero balances, owners that are off-curve (PDAs: pool vaults, escrows), and `exclude`.
 * Returned sorted by amount descending.
 */
export async function snapshotHolders(
  conn: Connection,
  mint: string,
  tokenProgram: string,
  exclude: Set<string>,
): Promise<Holder[]> {
  const pid = new PublicKey(tokenProgram);
  const filters: ({ dataSize: number } | { memcmp: { offset: number; bytes: string } })[] = [];
  // Token-2022 accounts can exceed 165 bytes (extensions), so only classic gets a size filter.
  if (!pid.equals(TOKEN_2022_PROGRAM_ID)) filters.push({ dataSize: 165 });
  filters.push({ memcmp: { offset: 0, bytes: mint } });

  const accounts = await conn.getProgramAccounts(pid, {
    commitment: 'confirmed',
    filters,
    dataSlice: { offset: 32, length: 40 },
  });

  const totals = new Map<string, bigint>();
  const curveCache = new Map<string, boolean>();
  for (const { account } of accounts) {
    const p = parseSlice(account.data);
    if (!p || p.amount === 0n) continue;
    const owner = new PublicKey(p.owner);
    const key = owner.toBase58();
    if (exclude.has(key)) continue;
    let onCurve = curveCache.get(key);
    if (onCurve === undefined) {
      onCurve = PublicKey.isOnCurve(p.owner);
      curveCache.set(key, onCurve);
    }
    if (!onCurve) continue;
    totals.set(key, (totals.get(key) ?? 0n) + p.amount);
  }
  return [...totals.entries()]
    .map(([owner, amountRaw]) => ({ owner, amountRaw }))
    .sort((a, b) => (a.amountRaw === b.amountRaw ? (a.owner < b.owner ? -1 : 1) : a.amountRaw > b.amountRaw ? -1 : 1));
}

/**
 * Which of `owners` already have their associated token account for `mint` created.
 * Uses getMultipleAccountsInfo in chunks of 100.
 */
export async function getOwnersWithAta(
  conn: Connection,
  mint: string,
  tokenProgram: string,
  owners: string[],
): Promise<Set<string>> {
  const pid = new PublicKey(tokenProgram);
  const mintKey = new PublicKey(mint);
  const have = new Set<string>();
  for (let i = 0; i < owners.length; i += 100) {
    const chunk = owners.slice(i, i + 100);
    const atas = chunk.map((o) => getAssociatedTokenAddressSync(mintKey, new PublicKey(o), true, pid));
    const infos = await conn.getMultipleAccountsInfo(atas, 'confirmed');
    infos.forEach((info, j) => {
      // Must be owned by the token program (a squatted system account is not an ATA).
      if (info && info.owner.equals(pid)) have.add(chunk[j]!);
    });
  }
  return have;
}
