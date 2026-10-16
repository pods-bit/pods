/** Build-time configuration. Everything else comes from the keeper's published JSON. */

const trimSlash = (s: string): string => s.replace(/\/+$/, '');

export const DATA_BASE = trimSlash(import.meta.env.VITE_DATA_BASE || './data');
export const SAMPLE_BASE = './sample';
export const RPC_URL = import.meta.env.VITE_RPC_URL || 'https://api.mainnet-beta.solana.com';
export const JUPITER_PRICE_URL = 'https://lite-api.jup.ag/price/v3';

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const POD_ORIGIN = 'https://orcapod.fun';
export const POLL_MS = 30_000;
export const FETCH_TIMEOUT_MS = 10_000;

export const LAMPORTS_PER_SOL = 1_000_000_000;

export function tradeUrl(pod5Mint: string | undefined): string {
  return pod5Mint ? `${POD_ORIGIN}/t/${encodeURIComponent(pod5Mint)}` : `${POD_ORIGIN}/markets`;
}
