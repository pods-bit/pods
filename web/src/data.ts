import type { OwedSnapshot, PublicState } from '../../shared/types';
import {
  DATA_BASE,
  FETCH_TIMEOUT_MS,
  JUPITER_PRICE_URL,
  RPC_URL,
  SAMPLE_BASE,
  WSOL_MINT,
} from './config';

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return await res.json(); // throws on HTML fallbacks served with 200
  } finally {
    clearTimeout(timer);
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

function asState(v: unknown): PublicState {
  if (!isObj(v) || !Array.isArray(v.basket) || !Array.isArray(v.rounds) || !Array.isArray(v.rejected)) {
    throw new Error('state.json has an unexpected shape');
  }
  return v as unknown as PublicState;
}
function asOwed(v: unknown): OwedSnapshot {
  if (!isObj(v) || !isObj(v.owed) || !isObj(v.delivered)) throw new Error('owed.json has an unexpected shape');
  return v as unknown as OwedSnapshot;
}

export interface Loaded<T> {
  data: T;
  preview: boolean;
}

/** Live keeper JSON first; the bundled sample only when the live file is missing or unreadable. */
async function loadWithFallback<T>(name: string, parse: (v: unknown) => T): Promise<Loaded<T>> {
  try {
    return { data: parse(await fetchJson(`${DATA_BASE}/${name}`, { cache: 'no-cache' })), preview: false };
  } catch {
    return { data: parse(await fetchJson(`${SAMPLE_BASE}/${name}`)), preview: true };
  }
}

export const loadState = (): Promise<Loaded<PublicState>> => loadWithFallback('state.json', asState);
export const loadOwed = (): Promise<Loaded<OwedSnapshot>> => loadWithFallback('owed.json', asOwed);

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const body = await fetchJson(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!isObj(body) || body.error || !('result' in body)) throw new Error(`rpc ${method} failed`);
  return body.result;
}

/** SOL balance of an address, in lamports. */
export async function getBalanceLamports(address: string): Promise<number> {
  const r = await rpc('getBalance', [address, { commitment: 'confirmed' }]);
  if (!isObj(r) || typeof r.value !== 'number') throw new Error('bad getBalance result');
  return r.value;
}

/** Sum of an owner's balance of one mint, as a decimal number of whole tokens. */
export async function getTokenBalance(owner: string, mint: string): Promise<number> {
  const r = await rpc('getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  if (!isObj(r) || !Array.isArray(r.value)) throw new Error('bad getTokenAccountsByOwner result');
  let total = 0;
  for (const acc of r.value) {
    const info = (acc as { account?: { data?: { parsed?: { info?: { tokenAmount?: { uiAmount?: number | null } } } } } })
      .account?.data?.parsed?.info?.tokenAmount;
    if (info && typeof info.uiAmount === 'number') total += info.uiAmount;
  }
  return total;
}

/** USD price of a mint via Jupiter price v3: { [mint]: { usdPrice, ... } }. Null when unpriced. */
export async function getUsdPrice(mint: string): Promise<number | null> {
  const r = await fetchJson(`${JUPITER_PRICE_URL}?ids=${encodeURIComponent(mint)}`);
  if (!isObj(r)) return null;
  const entry = r[mint];
  if (isObj(entry) && typeof entry.usdPrice === 'number' && Number.isFinite(entry.usdPrice)) return entry.usdPrice;
  return null;
}

export const getSolUsd = (): Promise<number | null> => getUsdPrice(WSOL_MINT);
