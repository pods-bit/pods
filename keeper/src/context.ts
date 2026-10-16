import type { Connection, Keypair, PublicKey } from '@solana/web3.js';
import type { Config } from './config';
import type { Ledger } from './ledger/db';
import type { Logger } from './log';

export interface KeeperContext {
  cfg: Config;
  conn: Connection;
  /** Keeper wallet address (always known; from keypair or KEEPER_PUBKEY). */
  keeper: PublicKey;
  /** Null in dry-run when no keypair is configured. Never null when dryRun is false. */
  signer: Keypair | null;
  ledger: Ledger;
  log: Logger;
  dryRun: boolean;
  /** Unix seconds; injectable for tests. */
  now(): number;
}
