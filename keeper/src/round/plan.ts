// Pure round math. No I/O, no clocks, no randomness: everything here is unit-tested.
//
// Precision policy: all lamport / raw-token arithmetic is bigint. USD figures arrive as
// floats (prices from Jupiter/Pod); where a USD threshold decides money movement
// (qualifyHolders, deliveryDecision) the float is first converted to an exact decimal
// fixed-point bigint (18 fractional digits via toFixed) and the comparison is done in bigint,
// so "worth exactly $30" is decided exactly for the float value given.

export interface Holder {
  owner: string;
  amountRaw: bigint;
}

const E9 = 1_000_000_000n;
/** Fixed-point scale for USD amounts (18 fractional digits). */
const USD_SCALE_DIGITS = 18;

function pow10(n: number): bigint {
  return 10n ** BigInt(n);
}

/**
 * Convert a non-negative finite float to fixed-point bigint with 18 fractional digits
 * (round-half-up as done by toFixed on the exact double value). Returns 0n for NaN/<=0.
 * Values >= 1e21 are clamped to 1e21 (toFixed switches to exponent notation there).
 */
function usdToFixed(x: number): bigint {
  if (!Number.isFinite(x) || x <= 0) return 0n;
  const clamped = Math.min(x, 1e21 - 1e6);
  const s = clamped.toFixed(USD_SCALE_DIGITS); // e.g. "0.003000000000000000"
  const [intPart, fracPart = ''] = s.split('.');
  return BigInt(intPart! + fracPart.padEnd(USD_SCALE_DIGITS, '0'));
}

/**
 * pot = balance - opReserve - estFees, capped at potCap (when set).
 * skip (non-null reason) when pot < minPot. pot is never negative.
 * When skipping, `pot` still holds the (non-negative, capped) computed value for logging.
 */
export function computePot(p: {
  balanceLamports: bigint;
  opReserveLamports: bigint;
  estFeesLamports: bigint;
  potCapLamports: bigint | null;
  minPotLamports: bigint;
}): { pot: bigint; skip: string | null } {
  let pot = p.balanceLamports - p.opReserveLamports - p.estFeesLamports;
  if (pot < 0n) pot = 0n;
  if (p.potCapLamports !== null && pot > p.potCapLamports) {
    pot = p.potCapLamports < 0n ? 0n : p.potCapLamports;
  }
  if (pot < p.minPotLamports) {
    return { pot, skip: `pot ${pot} lamports < min ${p.minPotLamports}` };
  }
  return { pot, skip: null };
}

/**
 * Split pot equally across caps.length coins (floor division), each slice capped at caps[i]
 * (the max a single buy may spend on that coin). unspent = pot - sum(slices).
 * Returns empty slices / unspent = pot when caps is empty.
 */
export function sliceAmounts(pot: bigint, caps: bigint[]): { slices: bigint[]; unspent: bigint } {
  const safePot = pot < 0n ? 0n : pot;
  if (caps.length === 0) return { slices: [], unspent: safePot };
  const base = safePot / BigInt(caps.length);
  const slices = caps.map((cap) => {
    const c = cap < 0n ? 0n : cap;
    return base < c ? base : c;
  });
  const spent = slices.reduce((a, b) => a + b, 0n);
  return { slices, unspent: safePot - spent };
}

/** Max lamports one buy may spend: liquidityUsd * maxSliceOfLiq converted at solUsd. */
export function liquidityCapLamports(liquidityUsd: number, maxSliceOfLiq: number, solUsd: number): bigint {
  if (!(solUsd > 0) || !(liquidityUsd > 0) || !(maxSliceOfLiq > 0)) return 0n;
  const lamports = Math.floor(((liquidityUsd * maxSliceOfLiq) / solUsd) * 1e9);
  if (!Number.isFinite(lamports) || lamports <= 0) return 0n;
  return BigInt(lamports);
}

/**
 * Keep holders whose balance is worth >= minHoldUsd at priceUsd.
 * Comparison is exact in bigint on the fixed-point values of priceUsd and minHoldUsd
 * (amountRaw * price >= minHold * 10^decimals), so the $30 boundary is inclusive and exact.
 * Unknown price (<= 0 / NaN) qualifies nobody.
 */
export function qualifyHolders(
  holders: Holder[],
  p: { priceUsd: number; decimals: number; minHoldUsd: number },
): Holder[] {
  const price = usdToFixed(p.priceUsd);
  if (price <= 0n) return [];
  const min = usdToFixed(p.minHoldUsd);
  const unit = pow10(p.decimals);
  const threshold = min * unit;
  return holders.filter((h) => h.amountRaw > 0n && h.amountRaw * price >= threshold);
}

/**
 * credits[owner] = floor(totalRaw * amount / sum(amount)). dust = totalRaw - sum(credits).
 * Zero credits are omitted. Empty holders -> no credits, dust = totalRaw.
 * Duplicate owners are summed; non-positive amounts are ignored; result keys are inserted in
 * sorted order so the output is independent of input order.
 */
export function allocateProRata(
  totalRaw: bigint,
  holders: Holder[],
): { credits: Map<string, bigint>; dust: bigint } {
  const credits = new Map<string, bigint>();
  const total = totalRaw < 0n ? 0n : totalRaw;
  const byOwner = new Map<string, bigint>();
  for (const h of holders) {
    if (h.amountRaw <= 0n) continue;
    byOwner.set(h.owner, (byOwner.get(h.owner) ?? 0n) + h.amountRaw);
  }
  let sum = 0n;
  for (const v of byOwner.values()) sum += v;
  if (sum === 0n || total === 0n) return { credits, dust: total };
  let allocated = 0n;
  for (const owner of [...byOwner.keys()].sort()) {
    const credit = (total * byOwner.get(owner)!) / sum;
    if (credit > 0n) {
      credits.set(owner, credit);
      allocated += credit;
    }
  }
  return { credits, dust: total - allocated };
}

export type DeliveryAction =
  | { kind: 'send'; amountRaw: bigint }
  | { kind: 'open'; amountRaw: bigint; rentWithheldRaw: bigint }
  | { kind: 'wait' };

/**
 * Decide what to do with one wallet's owed balance of one coin.
 * - owedRaw == 0 -> wait.
 * - hasAta -> send everything.
 * - no ATA: value = owed * price; rentUsd = rentLamports * solUsd / 1e9.
 *   If price or solUsd unknown (<= 0) or value < rentUsd * rentMargin -> wait.
 *   Else open: rentWithheldRaw = ceil(rentUsd / price in raw units), amountRaw = owed - withheld.
 * (If the withheld rent would consume the whole balance -- only possible with rentMargin < 1 --
 * the decision is wait.) All comparisons are exact in bigint on fixed-point USD values.
 */
export function deliveryDecision(p: {
  owedRaw: bigint;
  hasAta: boolean;
  tokenPriceUsd: number;
  decimals: number;
  solUsd: number;
  rentLamports: bigint;
  rentMargin: number;
}): DeliveryAction {
  if (p.owedRaw <= 0n) return { kind: 'wait' };
  if (p.hasAta) return { kind: 'send', amountRaw: p.owedRaw };

  const price = usdToFixed(p.tokenPriceUsd);
  const sol = usdToFixed(p.solUsd);
  if (price <= 0n || sol <= 0n || p.rentLamports <= 0n) return { kind: 'wait' };

  const unit = pow10(p.decimals);
  const marginMicro = BigInt(Math.round(Math.max(0, p.rentMargin) * 1e6));
  // value  = owed * price / unit                      (USD, scaled 1e18)
  // rent   = rentLamports * sol / 1e9                 (USD, scaled 1e18)
  // need   = value >= rent * margin
  //   <=>  owed * price * 1e9 * 1e6 >= rentLamports * sol * marginMicro * unit
  const lhs = p.owedRaw * price * E9 * 1_000_000n;
  const rhs = p.rentLamports * sol * marginMicro * unit;
  if (lhs < rhs) return { kind: 'wait' };

  // withheld = ceil(rent / (price / unit)) = ceil(rentLamports * sol * unit / (1e9 * price))
  const num = p.rentLamports * sol * unit;
  const den = E9 * price;
  const withheld = (num + den - 1n) / den;
  if (withheld >= p.owedRaw) return { kind: 'wait' };
  return { kind: 'open', amountRaw: p.owedRaw - withheld, rentWithheldRaw: withheld };
}

/**
 * Upper-bound network cost of a round: (swaps + delivery txs) * (5000 + priority fee for
 * ~200k CU on swaps / ~(transfersPerTx * 30k) CU on delivery), where delivery txs =
 * ceil(coins * recipients / transfersPerTx).
 */
export function estimateRoundFees(p: {
  coins: number;
  recipients: number;
  transfersPerTx: number;
  priorityFeeMicroLamports: number;
}): bigint {
  const coins = Math.max(0, Math.floor(p.coins));
  const recipients = Math.max(0, Math.floor(p.recipients));
  const per = Math.max(1, Math.floor(p.transfersPerTx));
  const prio = BigInt(Math.max(0, Math.floor(p.priorityFeeMicroLamports)));
  const BASE = 5000n;
  const prioFee = (cu: bigint) => (prio * cu + 999_999n) / 1_000_000n; // ceil(microLamports * CU / 1e6)

  const swapFee = BASE + prioFee(200_000n);
  const deliveryTxs = Math.ceil((coins * recipients) / per);
  const deliveryFee = BASE + prioFee(BigInt(per) * 30_000n);
  return BigInt(coins) * swapFee + BigInt(deliveryTxs) * deliveryFee;
}
