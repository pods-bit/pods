import { LAMPORTS_PER_SOL } from './config';

export const DASH = '—';

const usdCompact = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 1,
});
const usdFull = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
});
const intFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

const finite = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n);

export function fmtUsdCompact(n: number | null | undefined): string {
  if (!finite(n)) return DASH;
  return n < 1000 ? usdFull.format(n) : usdCompact.format(n);
}
export function fmtUsd(n: number | null | undefined): string {
  return finite(n) ? usdFull.format(n) : DASH;
}
export function fmtInt(n: number | null | undefined): string {
  return finite(n) ? intFmt.format(n) : DASH;
}
export function fmtPct(n: number | null | undefined): string {
  if (!finite(n)) return DASH;
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  return `${sign}${Math.abs(n).toFixed(1)}%`;
}

/** Lamports (decimal string or bigint) to a SOL number. Safe for display only. */
export function lamportsToSol(l: string | bigint | number): number {
  try {
    const b = typeof l === 'bigint' ? l : BigInt(typeof l === 'number' ? Math.trunc(l) : l);
    return Number(b) / LAMPORTS_PER_SOL;
  } catch {
    return NaN;
  }
}
export function fmtSol(sol: number | null | undefined, digits = 3): string {
  if (!finite(sol)) return DASH;
  if (sol === 0) return '0 SOL';
  const d = sol < 0.001 ? 5 : digits;
  return `${sol.toFixed(d)} SOL`;
}

/** Raw token amount (decimal string) to a readable string using exact bigint maths. */
export function fmtRaw(raw: string | undefined, decimals: number): string {
  if (!raw || !/^\d+$/.test(raw)) return DASH;
  const big = BigInt(raw);
  const base = 10n ** BigInt(decimals);
  const whole = big / base;
  const frac = big % base;
  const wholeStr = intFmt.format(Number(whole));
  if (frac === 0n) return wholeStr;
  const maxFrac = whole >= 1000n ? 2 : whole >= 1n ? 4 : 6;
  let fracStr = frac.toString().padStart(decimals, '0').slice(0, Math.min(maxFrac, decimals));
  fracStr = fracStr.replace(/0+$/, '');
  return fracStr ? `${wholeStr}.${fracStr}` : wholeStr;
}

export function timeAgo(unixSeconds: number | null | undefined, nowMs = Date.now()): string {
  if (!finite(unixSeconds) || unixSeconds <= 0) return DASH;
  const s = Math.max(0, Math.floor(nowMs / 1000 - unixSeconds));
  if (s < 45) return 'just now';
  if (s < 90) return '1 min ago';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} d ago`;
}

export function fmtDateTime(unixSeconds: number): string {
  if (!finite(unixSeconds) || unixSeconds <= 0) return DASH;
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a;
}

const B58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
export function isBase58Address(s: string): boolean {
  return s.length >= 32 && s.length <= 44 && B58.test(s);
}
/** Transaction signatures are 64 bytes: 86 to 88 base58 characters. */
export function isSignature(s: string | null | undefined): s is string {
  return typeof s === 'string' && s.length >= 80 && s.length <= 90 && B58.test(s);
}

export const solscanTx = (sig: string): string => `https://solscan.io/tx/${sig}`;
export const solscanAccount = (addr: string): string => `https://solscan.io/account/${addr}`;
