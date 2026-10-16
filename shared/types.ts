// Types shared by the keeper (producer) and the web site (consumer).
// Raw token amounts are bigint inside the keeper and decimal strings in JSON.

/** One coin as reported by Pod's GET /api/solana/markets, normalised. */
export interface PodMarket {
  mint: string;
  pool: string;
  symbol: string;
  name: string;
  image: string; // absolute URL
  quoteMint: string;
  quoteTicker: string;
  quoteUsd: number;
  priceUsd: number;
  marketCapUsd: number;
  /** quoteReserve × quoteUsd: USD value of the pair-token side of the pool. */
  liquidityUsd: number;
  volume24hUsd: number;
  trades24h: number;
  holders: number;
  change24h: number;
  createdAt: number; // unix seconds
  suspect: boolean;
  paused: boolean;
}

/** A coin that passed every basket filter for a round. */
export interface BasketCoin {
  mint: string;
  symbol: string;
  name: string;
  image: string;
  pool: string;
  decimals: number;
  tokenProgram: string; // Tokenkeg... or Token-2022 program id
  priceUsd: number;
  marketCapUsd: number;
  liquidityUsd: number;
  volume24hUsd: number;
  change24h: number;
  holders: number;
}

export interface RejectedCoin {
  mint: string;
  symbol: string;
  reason: string;
}

export type RoundStatus =
  | 'PLANNED'
  | 'BOUGHT'
  | 'CREDITED'
  | 'DELIVERING'
  | 'DONE'
  | 'SKIPPED'
  | 'FAILED';

export interface RoundBuyReceipt {
  mint: string;
  symbol: string;
  decimals: number;
  spentLamports: string;
  receivedRaw: string;
  signature: string | null;
  error?: string;
}

export interface RoundReceipt {
  id: number;
  startedAt: number; // unix seconds
  finishedAt: number | null;
  status: RoundStatus;
  skippedReason?: string;
  potLamports: string;
  eligibleWallets: number;
  basket: RoundBuyReceipt[];
  /** Number of transfers confirmed during this round's delivery step. */
  transfersSent: number;
  /** Signatures of delivery transactions confirmed in this round. */
  deliverySignatures: string[];
}

/** Published by the keeper to `${PUBLISH_DIR}/state.json`; read by the web site. */
export interface PublicState {
  updatedAt: number;
  cluster: 'mainnet-beta' | 'devnet' | 'localnet';
  pod5Mint: string;
  keeperWallet: string;
  /** Keeper SOL balance (lamports, decimal string) at publish time: the "fees waiting". */
  keeperLamports?: string | null;
  /** SOL/USD and POD5/USD at publish time (null when unavailable). Browsers can't always reach RPC. */
  solUsd?: number | null;
  pod5PriceUsd?: number | null;
  intervalMin: number;
  minHoldUsd: number;
  maxCoins: number;
  /** Basket as selected at the most recent round (or most recent dry-run). */
  basket: BasketCoin[];
  rejected: RejectedCoin[];
  rounds: RoundReceipt[]; // newest first, at most 50
  totals: {
    rounds: number;
    roundsRun: number;
    spentLamports: string;
    transfersSent: number;
    walletsPaid: number;
  };
}

/** Published to `${PUBLISH_DIR}/owed.json`: pending (credited, not yet delivered) shares. */
export interface OwedSnapshot {
  updatedAt: number;
  /** wallet -> mint -> raw amount (decimal string) */
  owed: Record<string, Record<string, string>>;
  /** wallet -> mint -> raw amount delivered all-time (decimal string) */
  delivered: Record<string, Record<string, string>>;
}
