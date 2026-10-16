import { WSOL_MINT } from '../config';
import type { KeeperContext } from '../context';
import { alert } from '../log';
import { checkMint } from '../chain/mintCheck';
import { getOwnersWithAta, snapshotHolders } from '../chain/holders';
import { getAtaRentLamports, getSolBalance } from '../chain/rpc';
import { fetchMarkets } from '../sources/pod';
import { getPricesUsd, getQuoteMeasured, type JupQuote } from '../sources/jupiter';
import {
  allocateProRata,
  computePot,
  deliveryDecision,
  estimateRoundFees,
  liquidityCapLamports,
  qualifyHolders,
  sliceAmounts,
  type Holder,
} from './plan';
import { selectBasket, type BasketDeps } from './selectBasket';
import { errMsg, executeBuy, resumeBuy } from './buy';
import { deliverMint, resumeDeliveries } from './deliver';
import { META_LAST_SELECTION, publishState } from '../publish';
import type { BasketCoin, RejectedCoin, RoundBuyReceipt, RoundReceipt } from '../../../shared/types';

export interface RoundOptions {
  /** Dry-run only: pretend the pot is this many lamports instead of reading the keeper balance. */
  potOverrideLamports?: bigint;
  /** Dry-run only: snapshot holders of this mint instead of cfg.pod5Mint. */
  holdersMintOverride?: string;
}

// ---- ledger meta keys ----
export const META_LAST_ELIGIBLE = 'last_eligible_wallets';
export const META_SKIP_KIND = 'last_skip_kind';
export const META_SKIP_AT = 'last_skip_at';
export const holdersMetaKey = (roundId: number) => `round_holders:${roundId}`;

/** A skip with the same kind as the previous one is recorded at most once per this many seconds. */
export const SKIP_RECORD_INTERVAL_SEC = 3600;
/** Recipients estimate for the fee reserve before any round has run. */
const DEFAULT_RECIPIENTS_EST = 200;

type SkipKind = 'sol_price' | 'markets' | 'pot' | 'no_coins' | 'pod5_price' | 'no_holders';

/** checkMint reports ok=false for unsafe-but-readable mints too; only these mean "unreadable". */
function mintUnreadable(mc: { ok: boolean; reason?: string; tokenProgram: string }): boolean {
  return !mc.tokenProgram || (!mc.ok && /missing|not an SPL token/i.test(mc.reason ?? ''));
}

const compact = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));

function serializeHolders(h: Holder[]): string {
  return JSON.stringify(h.map((x) => [x.owner, x.amountRaw.toString()]));
}

function loadHolders(ctx: KeeperContext, roundId: number): Holder[] | null {
  const raw = ctx.ledger.getMeta(holdersMetaKey(roundId));
  if (!raw) return null;
  const arr = JSON.parse(raw) as Array<[string, string]>;
  return arr.map(([owner, amt]) => ({ owner, amountRaw: BigInt(amt) }));
}

function fmtSol(l: bigint): string {
  return `${(Number(l) / 1e9).toFixed(4)} SOL`;
}

function fmtUnits(raw: bigint, decimals: number): string {
  const n = Number(raw) / 10 ** decimals;
  return n.toLocaleString('en-US', { maximumFractionDigits: n < 1 ? 6 : 2 });
}

function short(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : addr;
}

function synthetic(
  ctx: KeeperContext,
  p: {
    startedAt: number;
    status: RoundReceipt['status'];
    pot: bigint;
    eligible?: number;
    reason?: string;
    basket?: RoundBuyReceipt[];
  },
): RoundReceipt {
  const r: RoundReceipt = {
    id: 0,
    startedAt: p.startedAt,
    finishedAt: ctx.now(),
    status: p.status,
    potLamports: p.pot.toString(),
    eligibleWallets: p.eligible ?? 0,
    basket: p.basket ?? [],
    transfersSent: 0,
    deliverySignatures: [],
  };
  if (p.reason) r.skippedReason = p.reason;
  return r;
}

async function safePublish(
  ctx: KeeperContext,
  preview?: { basket: BasketCoin[]; rejected: RejectedCoin[] },
): Promise<void> {
  try {
    await publishState(ctx, preview);
  } catch (e) {
    ctx.log.warn('publishState failed', { error: errMsg(e) });
  }
}

function basketDeps(ctx: KeeperContext): BasketDeps {
  return {
    checkMint: (mint) => checkMint(ctx.conn, mint),
    quoteImpactBps: async (mint, lamports) => {
      const q = await getQuoteMeasured(ctx.cfg, {
        inputMint: WSOL_MINT,
        outputMint: mint,
        amount: lamports,
        slippageBps: ctx.cfg.slippageBps,
      });
      return q ? q.priceImpactBps : null;
    },
  };
}

/**
 * Record (rate-limited) and return a skipped round. In dry-run nothing is recorded; the reason
 * is printed and the basket preview (if any) is published.
 */
async function skipRound(
  ctx: KeeperContext,
  p: {
    startedAt: number;
    kind: SkipKind;
    reason: string;
    pot: bigint;
    eligible?: number;
    basket?: BasketCoin[];
    rejected?: RejectedCoin[];
  },
): Promise<RoundReceipt> {
  const { ledger, log } = ctx;
  const preview = p.basket ? { basket: p.basket, rejected: p.rejected ?? [] } : undefined;
  const fallback = synthetic(ctx, { startedAt: p.startedAt, status: 'SKIPPED', pot: p.pot, eligible: p.eligible, reason: p.reason });

  if (ctx.dryRun) {
    console.log(`\n=> would SKIP this round: ${p.reason}`);
    if (preview) await safePublish(ctx, preview);
    return fallback;
  }

  log.info('round skipped', { reason: p.reason });
  const now = ctx.now();
  const lastKind = ledger.getMeta(META_SKIP_KIND);
  const lastAt = Number(ledger.getMeta(META_SKIP_AT) ?? '0') || 0;
  let receipt = fallback;
  if (lastKind === p.kind && now - lastAt < SKIP_RECORD_INTERVAL_SEC) {
    log.info('skip not recorded (same reason recorded within the last hour)', { kind: p.kind });
  } else {
    const id = ledger.createRound({
      startedAt: p.startedAt,
      potLamports: p.pot,
      eligibleWallets: p.eligible ?? 0,
      basket: p.basket ?? [],
      rejected: p.rejected ?? [],
      status: 'SKIPPED',
      skippedReason: p.reason,
    });
    ledger.setRoundStatus(id, 'SKIPPED', { skippedReason: p.reason, finishedAt: now });
    ledger.setMeta(META_SKIP_KIND, p.kind);
    ledger.setMeta(META_SKIP_AT, String(now));
    receipt = ledger.getRound(id) ?? fallback;
  }
  if (preview) ledger.setMeta(META_LAST_SELECTION, compact(preview));
  await safePublish(ctx);
  return receipt;
}

/**
 * One full round. Steps: resume pending work -> pot -> basket -> snapshot/qualify ->
 * buys -> credits -> deliver every owed mint -> publish. Persists state transitions in the
 * ledger (PLANNED -> BOUGHT -> CREDITED -> DELIVERING -> DONE, or SKIPPED/FAILED).
 * In ctx.dryRun: performs every read (balances, markets, quotes, holders) and logs/prints the
 * plan, but writes nothing to the ledger and sends nothing; returns a synthetic receipt (id 0).
 *
 * Live: if a previous round cannot be finished (e.g. a sent buy is not settled yet), no new
 * round starts and that unfinished round's receipt is returned. Unexpected errors are logged,
 * alerted and rethrown; the round is marked FAILED only if no buy transaction was ever sent,
 * otherwise it is left unfinished for resumePending.
 */
export async function runRound(ctx: KeeperContext, opts: RoundOptions = {}): Promise<RoundReceipt> {
  if (!ctx.dryRun) {
    if (opts.potOverrideLamports !== undefined || opts.holdersMintOverride) {
      throw new Error('potOverrideLamports / holdersMintOverride are only allowed in dry-run');
    }
    if (!ctx.signer) throw new Error('a live round requires the keeper signer (KEEPER_KEYPAIR)');
  }
  try {
    return await runRoundInner(ctx, opts, ctx.now());
  } catch (e) {
    ctx.log.error('round error', { error: errMsg(e) });
    await alert(ctx.cfg, `round error: ${errMsg(e)}`);
    throw e;
  }
}

async function runRoundInner(ctx: KeeperContext, opts: RoundOptions, startedAt: number): Promise<RoundReceipt> {
  const { cfg, ledger, log, conn } = ctx;
  const dry = ctx.dryRun;
  const say = (s: string) => {
    if (dry) console.log(s);
  };

  if (!dry) {
    try {
      await resumePending(ctx);
    } catch (e) {
      log.error('resumePending failed', { error: errMsg(e) });
      await alert(cfg, `resumePending failed: ${errMsg(e)}`);
    }
    const unfinished = ledger.getUnfinishedRound();
    if (unfinished) {
      log.warn('previous round is unfinished; not starting a new one', { roundId: unfinished.id, status: unfinished.status });
      return unfinished;
    }
  }

  const holdersMint = opts.holdersMintOverride ?? cfg.pod5Mint;
  if (!holdersMint) throw new Error('POD5_MINT is not configured (dry-run: pass --holders-of <mint>)');

  // ---- pot ----
  const balance = await getSolBalance(conn, ctx.keeper);
  const solUsd = (await getPricesUsd(cfg, [WSOL_MINT]))[WSOL_MINT] ?? 0;
  say(`\n=== POD5 round DRY-RUN (${new Date(startedAt * 1000).toISOString()}) ===`);
  say(`keeper ${ctx.keeper.toBase58()}  balance ${fmtSol(balance)}  SOL/USD ${solUsd || 'n/a'}`);
  if (!(solUsd > 0)) {
    return skipRound(ctx, { startedAt, kind: 'sol_price', reason: 'SOL/USD price unavailable', pot: 0n });
  }

  let markets;
  try {
    markets = await fetchMarkets(cfg);
  } catch (e) {
    return skipRound(ctx, { startedAt, kind: 'markets', reason: `Pod markets unavailable: ${errMsg(e)}`, pot: 0n });
  }

  const recipientsEst = Number(ledger.getMeta(META_LAST_ELIGIBLE) ?? '') || DEFAULT_RECIPIENTS_EST;
  const estFees = estimateRoundFees({
    coins: cfg.maxCoins,
    recipients: recipientsEst,
    transfersPerTx: cfg.transfersPerTx,
    priorityFeeMicroLamports: cfg.priorityFeeMicroLamports,
  });
  let pot: bigint;
  let potSkip: string | null;
  if (opts.potOverrideLamports !== undefined) {
    pot = opts.potOverrideLamports;
    potSkip = null;
    say(`pot ${fmtSol(pot)} (OVERRIDE)`);
  } else {
    ({ pot, skip: potSkip } = computePot({
      balanceLamports: balance,
      opReserveLamports: cfg.opReserveLamports,
      estFeesLamports: estFees,
      potCapLamports: cfg.potCapLamports,
      minPotLamports: cfg.minPotLamports,
    }));
    say(
      `pot ${fmtSol(pot)} = balance − reserve ${fmtSol(cfg.opReserveLamports)} − est. fees ${fmtSol(estFees)}` +
        (cfg.potCapLamports !== null ? ` (cap ${fmtSol(cfg.potCapLamports)})` : ''),
    );
  }
  if (potSkip && !dry) return skipRound(ctx, { startedAt, kind: 'pot', reason: potSkip, pot });
  if (potSkip) say(`!! live run would skip: ${potSkip} (continuing the dry-run preview)`);

  // ---- basket ----
  const { coins, rejected } = await selectBasket(markets, cfg, pot, solUsd, basketDeps(ctx), ctx.now());
  say(`\nbasket (${coins.length}/${cfg.maxCoins}):`);
  for (const c of coins) {
    say(`  ${c.symbol.padEnd(10)} ${c.mint}  mcap $${Math.round(c.marketCapUsd).toLocaleString('en-US')}  liq $${Math.round(c.liquidityUsd).toLocaleString('en-US')}`);
  }
  if (rejected.length) {
    say(`rejected (${rejected.length}):`);
    for (const r of rejected) say(`  ${r.symbol.padEnd(10)} ${r.mint}  ${r.reason}`);
  }
  if (coins.length === 0) {
    return skipRound(ctx, { startedAt, kind: 'no_coins', reason: 'no coin passed the basket filters', pot, basket: coins, rejected });
  }

  // ---- holders ----
  const hm = await checkMint(conn, holdersMint);
  if (mintUnreadable(hm)) throw new Error(`cannot read holders mint ${holdersMint}: ${hm.reason ?? 'unknown'}`);
  const exclude = new Set([...cfg.excludeWallets, ctx.keeper.toBase58()]);
  const holders = await snapshotHolders(conn, holdersMint, hm.tokenProgram, exclude);
  const holdPrice =
    (await getPricesUsd(cfg, [holdersMint]))[holdersMint] ?? markets.find((m) => m.mint === holdersMint)?.priceUsd ?? 0;
  say(`\nholders of ${holdersMint}${opts.holdersMintOverride ? ' (OVERRIDE)' : ''}: ${holders.length}, price $${holdPrice || 'n/a'}`);
  if (!(holdPrice > 0)) {
    return skipRound(ctx, { startedAt, kind: 'pod5_price', reason: 'POD5 price unavailable', pot, basket: coins, rejected });
  }
  const qualified = qualifyHolders(holders, { priceUsd: holdPrice, decimals: hm.decimals, minHoldUsd: cfg.minHoldUsd });
  say(`eligible wallets (>= $${cfg.minHoldUsd}): ${qualified.length}`);
  if (qualified.length === 0) {
    return skipRound(ctx, {
      startedAt,
      kind: 'no_holders',
      reason: `no wallet holds >= $${cfg.minHoldUsd} of POD5`,
      pot,
      basket: coins,
      rejected,
    });
  }

  // ---- slices ----
  const caps = coins.map((c) => liquidityCapLamports(c.liquidityUsd, cfg.maxSliceOfLiq, solUsd));
  const { slices, unspent } = sliceAmounts(pot, caps);

  if (dry) {
    return dryRunReport(ctx, {
      startedAt,
      pot,
      potSkip,
      solUsd,
      coins,
      rejected,
      caps,
      slices,
      unspent,
      qualified,
      holdersDecimals: hm.decimals,
    });
  }

  // ---- live: plan -> buys -> credits -> delivery ----
  const roundId = ledger.createRound({ startedAt, potLamports: pot, eligibleWallets: qualified.length, basket: coins, rejected });
  // The holder snapshot is persisted before any buy so a resumed round credits the same weights.
  ledger.setMeta(holdersMetaKey(roundId), serializeHolders(qualified));
  ledger.setMeta(META_LAST_ELIGIBLE, String(qualified.length));
  ledger.setMeta(META_LAST_SELECTION, compact({ basket: coins, rejected }));
  ledger.setMeta(META_SKIP_KIND, '');
  log.info('round planned', {
    roundId,
    pot,
    unspent,
    eligible: qualified.length,
    basket: coins.map((c, i) => ({ symbol: c.symbol, mint: c.mint, slice: slices[i] ?? 0n })),
  });

  try {
    for (let i = 0; i < coins.length; i++) {
      const coin = coins[i]!;
      const r = await executeBuy(ctx, roundId, coin, slices[i] ?? 0n);
      if (r.error) log.warn('buy not completed', { roundId, symbol: coin.symbol, error: r.error });
    }
    await finishRound(ctx, roundId, { solUsd, basket: coins });
  } catch (e) {
    const sent = ledger.getBuys(roundId).some((b) => b.signature !== null);
    if (!sent) {
      ledger.setRoundStatus(roundId, 'FAILED', { finishedAt: ctx.now() });
      await safePublish(ctx);
    } else {
      log.error('round left unfinished; resumePending will settle it on the next run', { roundId });
    }
    throw e;
  }
  return ledger.getRound(roundId)!;
}

/** Credit every CONFIRMED buy of the round that has not been credited yet. */
async function creditRound(ctx: KeeperContext, roundId: number): Promise<void> {
  const { ledger, log } = ctx;
  const todo = ledger.getBuys(roundId).filter((b) => b.state === 'CONFIRMED' && !ledger.hasCredits(roundId, b.mint));
  if (todo.length === 0) return;
  const holders = loadHolders(ctx, roundId);
  if (!holders || holders.length === 0) {
    throw new Error(`round ${roundId}: holder snapshot missing; cannot credit ${todo.length} confirmed buy(s)`);
  }
  for (const b of todo) {
    const carry = ledger.getCarry(b.mint);
    const total = b.receivedRaw + carry;
    const { credits, dust } = allocateProRata(total, holders);
    let sum = dust;
    for (const v of credits.values()) {
      if (v < 0n) throw new Error(`negative credit computed for ${b.mint}`);
      sum += v;
    }
    if (sum !== total || dust < 0n) {
      throw new Error(`credit allocation for ${b.mint} does not add up: ${sum} != ${total}`);
    }
    ledger.applyCredits(roundId, b.mint, credits, dust);
    log.info('credited', { roundId, mint: b.mint, received: b.receivedRaw, carryIn: carry, wallets: credits.size, carryOut: dust });
  }
}

/** Deliver every mint with an owed balance (not just this round's). Per-mint errors are alerted, not thrown. */
async function deliverAll(
  ctx: KeeperContext,
  roundId: number,
  hint?: { solUsd?: number; basket?: BasketCoin[] },
): Promise<void> {
  const { cfg, ledger, log, conn } = ctx;
  const mints = ledger.getOwedMints();
  if (mints.length === 0) return;
  const basket = hint?.basket ?? ledger.getRoundBasket(roundId);
  let prices: Record<string, number> = {};
  try {
    prices = await getPricesUsd(cfg, [WSOL_MINT, ...mints]);
  } catch (e) {
    log.warn('price lookup for delivery failed; using basket prices', { error: errMsg(e) });
  }
  const solUsd = prices[WSOL_MINT] ?? hint?.solUsd ?? 0;
  for (const mint of mints) {
    try {
      const b = basket.find((c) => c.mint === mint);
      let decimals: number;
      let tokenProgram: string;
      if (b) {
        decimals = b.decimals;
        tokenProgram = b.tokenProgram;
      } else {
        const mc = await checkMint(conn, mint);
        if (mintUnreadable(mc)) throw new Error(`cannot read mint: ${mc.reason ?? 'unknown'}`);
        decimals = mc.decimals;
        tokenProgram = mc.tokenProgram;
      }
      const priceUsd = prices[mint] ?? b?.priceUsd ?? 0;
      const r = await deliverMint(ctx, roundId, { mint, decimals, tokenProgram, priceUsd }, solUsd);
      if (r.transfers > 0) log.info('delivered', { roundId, mint, transfers: r.transfers, txs: r.signatures.length });
    } catch (e) {
      log.error('delivery error', { roundId, mint, error: errMsg(e) });
      await alert(cfg, `delivery of ${mint} failed: ${errMsg(e)}`);
    }
  }
}

/**
 * Drive a live round from its recorded status to DONE:
 * PLANNED (settle SENT buys) -> BOUGHT -> credit -> CREDITED -> DELIVERING -> deliver -> DONE.
 * Throws (leaving the status where it is) if a sent buy cannot be settled yet.
 */
async function finishRound(
  ctx: KeeperContext,
  roundId: number,
  hint?: { solUsd?: number; basket?: BasketCoin[] },
): Promise<void> {
  const { ledger, log } = ctx;
  const round = ledger.getRound(roundId);
  if (!round) throw new Error(`round ${roundId} not found`);
  let status = round.status;

  if (status === 'PLANNED') {
    for (const b of ledger.getBuys(roundId)) {
      if (b.state === 'SENT') await resumeBuy(ctx, b);
      else if (b.state === 'PENDING' && !b.signature) {
        ledger.upsertBuy({ ...b, spentLamports: 0n, receivedRaw: 0n, state: 'FAILED', error: 'interrupted before send' });
      }
    }
    const unsettled = ledger.getBuys(roundId).filter((b) => b.state === 'SENT' || b.state === 'PENDING');
    if (unsettled.length > 0) {
      throw new Error(`round ${roundId}: ${unsettled.length} buy(s) not settled yet (${unsettled.map((b) => b.signature).join(', ')})`);
    }
    ledger.setRoundStatus(roundId, 'BOUGHT');
    status = 'BOUGHT';
  }
  if (status === 'BOUGHT') {
    await creditRound(ctx, roundId);
    ledger.setRoundStatus(roundId, 'CREDITED');
    status = 'CREDITED';
  }
  if (status === 'CREDITED') {
    ledger.setRoundStatus(roundId, 'DELIVERING');
    status = 'DELIVERING';
  }
  if (status === 'DELIVERING') {
    await deliverAll(ctx, roundId, hint);
    ledger.setRoundStatus(roundId, 'DONE', { finishedAt: ctx.now() });
    ledger.setMeta(holdersMetaKey(roundId), '');
    log.info('round done', { roundId });
  }
  await safePublish(ctx);
}

/** Finish an unfinished round and settle pending buy/delivery txs left by a crash. */
export async function resumePending(ctx: KeeperContext): Promise<void> {
  if (ctx.dryRun) return;
  await resumeDeliveries(ctx);
  const r = ctx.ledger.getUnfinishedRound();
  if (!r) return;
  ctx.log.info('resuming unfinished round', { roundId: r.id, status: r.status });
  await finishRound(ctx, r.id);
}

// ---------------------------------------------------------------------------------------------
// dry-run report

async function dryRunReport(
  ctx: KeeperContext,
  p: {
    startedAt: number;
    pot: bigint;
    potSkip: string | null;
    solUsd: number;
    coins: BasketCoin[];
    rejected: RejectedCoin[];
    caps: bigint[];
    slices: bigint[];
    unspent: bigint;
    qualified: Holder[];
    holdersDecimals: number;
  },
): Promise<RoundReceipt> {
  const { cfg, ledger, conn } = ctx;
  const out = (s: string) => console.log(s);
  const owners = p.qualified.map((h) => h.owner);
  const top = p.qualified.slice(0, 10);
  const receipts: RoundBuyReceipt[] = [];
  const perCoinCredits: Array<Map<string, bigint>> = [];

  out(`\nslices (unspent ${fmtSol(p.unspent)}):`);
  for (let i = 0; i < p.coins.length; i++) {
    const c = p.coins[i]!;
    const slice = p.slices[i] ?? 0n;
    let quote: JupQuote | null = null;
    let quoteErr: string | undefined;
    if (slice > 0n) {
      try {
        quote = await getQuoteMeasured(cfg, { inputMint: WSOL_MINT, outputMint: c.mint, amount: slice, slippageBps: cfg.slippageBps });
        if (!quote) quoteErr = 'no Jupiter route';
        else if (quote.priceImpactBps > cfg.maxImpactBps) quoteErr = `impact ${quote.priceImpactBps} bps > max ${cfg.maxImpactBps}`;
      } catch (e) {
        quoteErr = `quote failed: ${errMsg(e)}`;
      }
    } else {
      quoteErr = 'slice is zero';
    }
    const outRaw = quote && !quoteErr ? quote.outAmount : 0n;
    const carry = ledger.getCarry(c.mint);
    const { credits } = allocateProRata(outRaw + carry, p.qualified);
    perCoinCredits.push(credits);

    // Delivery preview: who would be sent now / get an account opened / wait.
    let counts = 'n/a';
    try {
      const withAta = await getOwnersWithAta(conn, c.mint, c.tokenProgram, owners);
      const rent = await getAtaRentLamports(conn, c.tokenProgram);
      const owed = ledger.getOwedForMint(c.mint);
      let send = 0;
      let open = 0;
      let wait = 0;
      for (const o of owners) {
        const owedRaw = (owed.get(o) ?? 0n) + (credits.get(o) ?? 0n);
        const d = deliveryDecision({
          owedRaw,
          hasAta: withAta.has(o),
          tokenPriceUsd: c.priceUsd,
          decimals: c.decimals,
          solUsd: p.solUsd,
          rentLamports: rent,
          rentMargin: cfg.rentMargin,
        });
        if (d.kind === 'send') send++;
        else if (d.kind === 'open') open++;
        else wait++;
      }
      counts = `send ${send} / open ${open} / wait ${wait} (ATA rent ${fmtSol(rent)})`;
    } catch (e) {
      counts = `delivery preview failed: ${errMsg(e)}`;
    }

    out(
      `  ${c.symbol.padEnd(10)} slice ${fmtSol(slice)} (cap ${fmtSol(p.caps[i] ?? 0n)})  ` +
        (quoteErr
          ? `NOT BOUGHT: ${quoteErr}`
          : `quote out ${fmtUnits(outRaw, c.decimals)} (${outRaw} raw), impact ${quote!.priceImpactBps} bps`) +
        `\n             carry ${carry} raw; delivery: ${counts}`,
    );
    const r: RoundBuyReceipt = {
      mint: c.mint,
      symbol: c.symbol,
      decimals: c.decimals,
      spentLamports: quoteErr ? '0' : slice.toString(),
      receivedRaw: outRaw.toString(),
      signature: null,
    };
    if (quoteErr) r.error = quoteErr;
    receipts.push(r);
  }

  out(`\ntop ${top.length} of ${p.qualified.length} eligible wallets (simulated credits):`);
  out(`  ${'wallet'.padEnd(11)} ${'holding'.padStart(16)}  ` + p.coins.map((c) => c.symbol.padStart(14)).join(' '));
  for (const h of top) {
    const cells = p.coins.map((c, i) => fmtUnits(perCoinCredits[i]!.get(h.owner) ?? 0n, c.decimals).padStart(14));
    out(`  ${short(h.owner).padEnd(11)} ${fmtUnits(h.amountRaw, p.holdersDecimals).padStart(16)}  ${cells.join(' ')}`);
  }
  out(p.potSkip ? `\n=> live run would SKIP: ${p.potSkip}` : `\n=> live run would buy ${receipts.filter((r) => !r.error).length} coin(s)`);
  out('(dry-run: nothing written, nothing sent)\n');

  await safePublish(ctx, { basket: p.coins, rejected: p.rejected });
  return synthetic(ctx, {
    startedAt: p.startedAt,
    status: p.potSkip ? 'SKIPPED' : 'PLANNED',
    pot: p.pot,
    eligible: p.qualified.length,
    reason: p.potSkip ?? undefined,
    basket: receipts,
  });
}
