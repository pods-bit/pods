import { PublicKey, type Connection } from '@solana/web3.js';
import {
  AccountState,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getDefaultAccountState,
  getExtensionTypes,
  getMint,
} from '@solana/spl-token';

export interface MintCheck {
  ok: boolean;
  /** Why the mint is unsafe for the basket; undefined when ok. */
  reason?: string;
  decimals: number;
  tokenProgram: string;
}

const BAD_EXTENSIONS: ReadonlyMap<ExtensionType, string> = new Map([
  [ExtensionType.TransferFeeConfig, 'Token-2022 TransferFeeConfig'],
  [ExtensionType.PermanentDelegate, 'Token-2022 PermanentDelegate'],
  [ExtensionType.TransferHook, 'Token-2022 TransferHook'],
  [ExtensionType.NonTransferable, 'Token-2022 NonTransferable'],
  [ExtensionType.ConfidentialTransferMint, 'Token-2022 ConfidentialTransfer'],
  // Extra: an issuer who can pause the mint can freeze every transfer we make.
  [ExtensionType.PausableConfig, 'Token-2022 Pausable'],
]);

/** Pure decision logic, exported for tests. Returns the first rejection reason or undefined. */
export function mintRejection(m: {
  mintAuthority: string | null;
  freezeAuthority: string | null;
  extensions: ExtensionType[];
  defaultStateFrozen: boolean;
}): string | undefined {
  if (m.freezeAuthority) return 'freeze authority set';
  if (m.mintAuthority) return 'mint authority set';
  for (const ext of m.extensions) {
    const bad = BAD_EXTENSIONS.get(ext);
    if (bad) return bad;
  }
  if (m.defaultStateFrozen) return 'Token-2022 DefaultAccountState=frozen';
  return undefined;
}

/**
 * Read the mint account. ok=false when: account missing; freeze authority set; mint
 * authority set; Token-2022 with TransferFeeConfig, PermanentDelegate, TransferHook,
 * NonTransferable, DefaultAccountState(frozen) or ConfidentialTransfer extensions.
 */
export async function checkMint(conn: Connection, mint: string): Promise<MintCheck> {
  const key = new PublicKey(mint);
  const info = await conn.getAccountInfo(key, 'confirmed');
  if (!info) return { ok: false, reason: 'mint account missing', decimals: 0, tokenProgram: TOKEN_PROGRAM_ID.toBase58() };

  const tokenProgram = info.owner.toBase58();
  const is2022 = info.owner.equals(TOKEN_2022_PROGRAM_ID);
  if (!is2022 && !info.owner.equals(TOKEN_PROGRAM_ID)) {
    return { ok: false, reason: `not an SPL token mint (owner ${tokenProgram})`, decimals: 0, tokenProgram };
  }

  const m = await getMint(conn, key, 'confirmed', info.owner);
  let extensions: ExtensionType[] = [];
  let defaultStateFrozen = false;
  if (is2022) {
    extensions = getExtensionTypes(m.tlvData);
    defaultStateFrozen = getDefaultAccountState(m)?.state === AccountState.Frozen;
  }
  const reason = mintRejection({
    mintAuthority: m.mintAuthority?.toBase58() ?? null,
    freezeAuthority: m.freezeAuthority?.toBase58() ?? null,
    extensions,
    defaultStateFrozen,
  });
  return reason
    ? { ok: false, reason, decimals: m.decimals, tokenProgram }
    : { ok: true, decimals: m.decimals, tokenProgram };
}
