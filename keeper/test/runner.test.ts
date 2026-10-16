import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicKey } from '@solana/web3.js';

vi.mock('../src/chain/rpc', () => ({
  createConnection: vi.fn(),
  loadKeeper: vi.fn(),
  getSolBalance: vi.fn(),
  getTokenBalanceRaw: vi.fn(),
  getAtaRentLamports: vi.fn(),
  buildAndSign: vi.fn(),
  signatureOf: vi.fn(),
  sendAndConfirm: vi.fn(),
  signatureStatus: vi.fn(),
  getBlockHeight: vi.fn(),
  getTxBalanceDelta: vi.fn(),
}));
vi.mock('../src/chain/holders', () => ({ snapshotHolders: vi.fn(), getOwnersWithAta: vi.fn() }));
vi.mock('../src/chain/mintCheck', () => ({ checkMint: vi.fn() }));
vi.mock('../src/sources/jupiter', () => ({ getQuote: vi.fn(), getQuoteMeasured: vi.fn(), buildSwapTransaction: vi.fn(), getPricesUsd: vi.fn() }));
vi.mock('../src/sources/pod', () => ({ fetchMarkets: vi.fn() }));
vi.mock('../src/round/plan', async () => (await import('./fakes')).planImpl);
vi.mock('../src/round/selectBasket', () => ({ selectBasket: vi.fn() }));
vi.mock('../src/round/deliver', () => ({ deliverMint: vi.fn(), resumeDeliveries: vi.fn() }));
vi.mock('../src/publish', () => ({ publishState: vi.fn(), META_LAST_SELECTION: 'last_selection' }));

import * as rpc from '../src/chain/rpc';
import * as holdersMod from '../src/chain/holders';
import * as mintCheck from '../src/chain/mintCheck';
import * as jup from '../src/sources/jupiter';
import * as pod from '../src/sources/pod';
import * as sel from '../src/round/selectBasket';
import * as deliver from '../src/round/deliver';
import * as publish from '../src/publish';
import { runRound, holdersMetaKey } from '../src/round/runner';
import { BuyUnsettledError } from '../src/round/buy';
import { WSOL_MINT } from '../src/config';
import type { KeeperContext } from '../src/context';
import { FakeLedger, coin, makeCtx, newAddress, testConfig } from './fakes';

const TOKENKEG = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SOL = 1_000_000_000n;

const A = coin(newAddress(), 'AAA');
const B = coin(newAddress(), 'BBB', { priceUsd: 0.02 });
const OLD = newAddress(); // a mint from an earlier round, no longer in the basket
const h1 = newAddress();
const h2 = newAddress();
const h3 = newAddress(); // below $30 -> not eligible
const RECEIVED: Record<string, bigint> = { [A.mint]: 777_777_777n, [B.mint]: 123_457n };

let ledger: FakeLedger;
let ctx: KeeperContext;

function setup(over: { balance?: bigint } = {}) {
  ledger = new FakeLedger();
  ctx = makeCtx({ ledger, cfg: testConfig() });
  const pod5 = ctx.cfg.pod5Mint!;

  vi.mocked(rpc.getSolBalance).mockResolvedValue(over.balance ?? 11n * SOL / 10n);
  vi.mocked(jup.getPricesUsd).mockImplementation(async (_cfg, mints) => {
    const all: Record<string, number> = { [WSOL_MINT]: 100, [pod5]: 1, [A.mint]: 0.01, [B.mint]: 0.02, [OLD]: 0.5 };
    return Object.fromEntries(mints.filter((m) => m in all).map((m) => [m, all[m]!]));
  });
  vi.mocked(pod.fetchMarkets).mockResolvedValue([]);
  vi.mocked(sel.selectBasket).mockResolvedValue({
    coins: [A, B],
    rejected: [{ mint: newAddress(), symbol: 'THIN', reason: 'liquidity $12 < $5000' }],
  });
  vi.mocked(mintCheck.checkMint).mockResolvedValue({ ok: true, decimals: 6, tokenProgram: TOKENKEG });
  vi.mocked(holdersMod.snapshotHolders).mockResolvedValue([
    { owner: h1, amountRaw: 1000_000_000n }, // $1000
    { owner: h2, amountRaw: 500_000_000n }, // $500
    { owner: h3, amountRaw: 10_000_000n }, // $10
  ]);
  vi.mocked(holdersMod.getOwnersWithAta).mockResolvedValue(new Set([h1]));
  vi.mocked(rpc.getAtaRentLamports).mockResolvedValue(2_039_280n);
  vi.mocked(jup.getQuoteMeasured).mockImplementation(async (_cfg, p) => ({
    inputMint: p.inputMint,
    outputMint: p.outputMint,
    inAmount: p.amount,
    outAmount: p.amount * 1000n,
    priceImpactBps: 50,
    raw: {},
  }));
  vi.mocked(jup.buildSwapTransaction).mockImplementation(async (_cfg, quote, user) => {
    expect(user).toBe(ctx.keeper.toBase58());
    const tx = {
      message: { staticAccountKeys: [ctx.keeper as PublicKey] },
      sign: vi.fn(),
      __sig: `swap-${quote.outputMint}`,
    };
    return { tx: tx as never, lastValidBlockHeight: 1000 };
  });
  vi.mocked(rpc.signatureOf).mockImplementation((tx) => (tx as unknown as { __sig: string }).__sig);
  vi.mocked(rpc.sendAndConfirm).mockResolvedValue('confirmed');
  vi.mocked(rpc.getTxBalanceDelta).mockImplementation(async (_c, _sig, owner, mint) => {
    expect(owner).toBe(ctx.keeper.toBase58());
    return { tokenDeltaRaw: RECEIVED[mint] ?? 0n, lamportsSpent: 500_000_000n };
  });
  vi.mocked(deliver.deliverMint).mockResolvedValue({ transfers: 2, signatures: ['dsig'] });
  vi.mocked(deliver.resumeDeliveries).mockResolvedValue();
  vi.mocked(publish.publishState).mockResolvedValue();
}

function owedSum(mint: string): bigint {
  return [...ledger.getOwedForMint(mint).values()].reduce((s, v) => s + v, 0n);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('runRound', () => {
  it('happy path: buys, credits received+carry pro-rata, delivers every owed mint, DONE, publishes', async () => {
    setup();
    ledger.carry.set(A.mint, 5n); // carry from earlier rounds
    ledger.seedOwed(h2, OLD, 42n); // owed from an earlier round, mint not in today's basket

    const r = await runRound(ctx);

    expect(r.status).toBe('DONE');
    expect(r.finishedAt).not.toBeNull();
    expect(r.basket.map((b) => b.mint).sort()).toEqual([A.mint, B.mint].sort());
    expect(r.basket.every((b) => b.signature && !b.error)).toBe(true);
    expect(r.eligibleWallets).toBe(2);

    // pot = 1.1 - 0.05 reserve - 0.001 est fees = 1.049 SOL, split in two equal slices
    const quoted = vi.mocked(jup.getQuoteMeasured).mock.calls.map((c) => c[1].amount);
    expect(quoted).toEqual([524_500_000n, 524_500_000n]);

    // credits + carry == received + carry-in, only eligible wallets credited
    expect(owedSum(A.mint) + ledger.getCarry(A.mint)).toBe(RECEIVED[A.mint]! + 5n);
    expect(owedSum(B.mint) + ledger.getCarry(B.mint)).toBe(RECEIVED[B.mint]!);
    expect(ledger.getOwedForMint(A.mint).has(h3)).toBe(false);
    expect(ledger.getOwedForMint(A.mint).get(h1)).toBe(((RECEIVED[A.mint]! + 5n) * 2n) / 3n);
    expect(ledger.hasCredits(1, A.mint) && ledger.hasCredits(1, B.mint)).toBe(true);

    // delivery for every owed mint, including the old one (resolved via checkMint)
    const delivered = vi.mocked(deliver.deliverMint).mock.calls.map((c) => c[2].mint).sort();
    expect(delivered).toEqual([A.mint, B.mint, OLD].sort());
    const oldCall = vi.mocked(deliver.deliverMint).mock.calls.find((c) => c[2].mint === OLD)!;
    expect(oldCall[2]).toMatchObject({ decimals: 6, tokenProgram: TOKENKEG, priceUsd: 0.5 });
    expect(oldCall[3]).toBe(100);
    expect(vi.mocked(mintCheck.checkMint).mock.calls.map((c) => c[1])).toContain(OLD);

    expect(publish.publishState).toHaveBeenCalled();
    expect(ledger.getMeta(holdersMetaKey(1))).toBe('');
    expect(ledger.getMeta('last_eligible_wallets')).toBe('2');
  });

  it('records the buy as SENT before broadcasting it', async () => {
    setup();
    vi.mocked(rpc.sendAndConfirm).mockImplementation(async () => {
      const sent = ledger.getBuys(1).filter((b) => b.state === 'SENT');
      expect(sent).toHaveLength(1);
      expect(sent[0]!.signature).toMatch(/^swap-/);
      expect(sent[0]!.lastValidBlockHeight).toBe(1000);
      return 'confirmed';
    });
    await runRound(ctx);
    expect(rpc.sendAndConfirm).toHaveBeenCalledTimes(2);
  });

  it('skips (and records once per hour) when the pot is under the minimum', async () => {
    setup({ balance: 80_000_000n }); // 0.08 SOL -> pot 0.029 < 0.05
    const r = await runRound(ctx);
    expect(r.status).toBe('SKIPPED');
    expect(r.skippedReason).toMatch(/below minimum/);
    expect(sel.selectBasket).not.toHaveBeenCalled();
    expect(jup.buildSwapTransaction).not.toHaveBeenCalled();
    expect(ledger.rounds.size).toBe(1);

    const again = await runRound(ctx); // same reason within the hour: not recorded again
    expect(again.status).toBe('SKIPPED');
    expect(again.id).toBe(0);
    expect(ledger.rounds.size).toBe(1);

    ctx.now = () => 1_800_000_000 + 3601;
    await runRound(ctx);
    expect(ledger.rounds.size).toBe(2);
  });

  it('skips when no coin passes the basket filters', async () => {
    setup();
    vi.mocked(sel.selectBasket).mockResolvedValue({
      coins: [],
      rejected: [{ mint: A.mint, symbol: 'AAA', reason: 'freeze authority set' }],
    });
    const r = await runRound(ctx);
    expect(r.status).toBe('SKIPPED');
    expect(r.skippedReason).toMatch(/no coin/);
    expect(holdersMod.snapshotHolders).not.toHaveBeenCalled();
    expect(jup.buildSwapTransaction).not.toHaveBeenCalled();
    expect(ledger.getMeta('last_selection')).toContain('freeze authority set');
  });

  it('dry-run sends nothing, writes nothing, and publishes the basket preview', async () => {
    setup();
    const other = newAddress();
    ctx = makeCtx({ ledger, cfg: testConfig({ pod5Mint: null }), dryRun: true, signer: null, keeper: ctx.keeper });
    vi.mocked(jup.getPricesUsd).mockImplementation(async (_cfg, mints) =>
      Object.fromEntries(mints.map((m) => [m, m === WSOL_MINT ? 100 : 1])),
    );

    const r = await runRound(ctx, { potOverrideLamports: 2n * SOL, holdersMintOverride: other });

    expect(r.id).toBe(0);
    expect(r.status).toBe('PLANNED');
    expect(r.basket).toHaveLength(2);
    expect(r.basket[0]!.spentLamports).toBe(String(SOL));
    expect(ledger.writes).toBe(0);
    expect(jup.buildSwapTransaction).not.toHaveBeenCalled();
    expect(rpc.sendAndConfirm).not.toHaveBeenCalled();
    expect(rpc.buildAndSign).not.toHaveBeenCalled();
    expect(deliver.deliverMint).not.toHaveBeenCalled();
    expect(deliver.resumeDeliveries).not.toHaveBeenCalled();
    expect(vi.mocked(holdersMod.snapshotHolders).mock.calls[0]![1]).toBe(other);
    expect(publish.publishState).toHaveBeenCalledWith(ctx, {
      basket: [A, B],
      rejected: expect.arrayContaining([expect.objectContaining({ symbol: 'THIN' })]),
    });
  });

  it('rejects overrides outside dry-run', async () => {
    setup();
    await expect(runRound(ctx, { potOverrideLamports: SOL })).rejects.toThrow(/dry-run/);
    expect(ledger.writes).toBe(0);
  });

  it('crash after a buy was SENT: resume settles it from chain status and completes without re-buying', async () => {
    setup();
    vi.mocked(rpc.sendAndConfirm).mockRejectedValueOnce(new Error('socket hang up'));

    // Run 1: the first buy is broadcast, then the process loses track of it.
    await expect(runRound(ctx)).rejects.toBeInstanceOf(BuyUnsettledError);
    expect(ledger.getRound(1)!.status).toBe('PLANNED');
    const buys1 = ledger.getBuys(1);
    expect(buys1).toHaveLength(1);
    expect(buys1[0]).toMatchObject({ mint: A.mint, state: 'SENT', signature: `swap-${A.mint}` });

    // Run 2: chain does not know the tx yet and blockhash still valid -> stay put, no new round.
    vi.mocked(rpc.getBlockHeight).mockResolvedValue(900);
    vi.mocked(rpc.signatureStatus).mockResolvedValue('unknown');
    const r2 = await runRound(ctx);
    expect(r2.id).toBe(1);
    expect(r2.status).toBe('PLANNED');
    expect(ledger.rounds.size).toBe(1);

    // Run 3: the tx landed. Resume confirms it, credits, delivers, finishes round 1.
    vi.mocked(rpc.signatureStatus).mockResolvedValue('confirmed');
    vi.mocked(rpc.getSolBalance).mockResolvedValue(60_000_000n); // new round then skips on pot
    const r3 = await runRound(ctx);

    const round1 = ledger.getRound(1)!;
    expect(round1.status).toBe('DONE');
    const a = ledger.getBuys(1).find((b) => b.mint === A.mint)!;
    expect(a.state).toBe('CONFIRMED');
    expect(a.receivedRaw).toBe(RECEIVED[A.mint]);
    expect(ledger.getBuys(1).find((b) => b.mint === B.mint)).toBeUndefined(); // never bought on resume
    expect(owedSum(A.mint) + ledger.getCarry(A.mint)).toBe(RECEIVED[A.mint]);
    expect(jup.buildSwapTransaction).toHaveBeenCalledTimes(1);
    expect(rpc.sendAndConfirm).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deliver.deliverMint).mock.calls.map((c) => c[1])).toEqual([1]);
    expect(r3.status).toBe('SKIPPED');
  });

  it('a resumed SENT buy whose blockhash expired is marked FAILED and the round still completes', async () => {
    setup();
    vi.mocked(rpc.sendAndConfirm).mockRejectedValueOnce(new Error('timeout'));
    await expect(runRound(ctx)).rejects.toThrow();
    vi.mocked(rpc.getBlockHeight).mockResolvedValue(1001); // past lastValidBlockHeight but within the margin
    vi.mocked(rpc.signatureStatus).mockResolvedValue('unknown');
    vi.mocked(rpc.getSolBalance).mockResolvedValue(60_000_000n);
    expect((await runRound(ctx)).status).toBe('PLANNED'); // not yet declared expired
    vi.mocked(rpc.getBlockHeight).mockResolvedValue(1000 + 151);
    vi.mocked(rpc.signatureStatus).mockResolvedValue('unknown');
    vi.mocked(rpc.getSolBalance).mockResolvedValue(60_000_000n);
    await runRound(ctx);
    expect(ledger.getRound(1)!.status).toBe('DONE');
    expect(ledger.getBuys(1)[0]).toMatchObject({ state: 'FAILED', spentLamports: 0n });
    expect(ledger.getOwedMints()).toEqual([]);
  });

  it('a failed buy leaves its SOL unspent while the other coin proceeds', async () => {
    setup();
    vi.mocked(rpc.sendAndConfirm).mockImplementation(async (_c, tx) =>
      (tx as unknown as { __sig: string }).__sig === `swap-${A.mint}` ? 'failed' : 'confirmed',
    );
    const r = await runRound(ctx);
    expect(r.status).toBe('DONE');
    const a = r.basket.find((b) => b.mint === A.mint)!;
    const b = r.basket.find((x) => x.mint === B.mint)!;
    expect(a.error).toMatch(/failed/);
    expect(a.spentLamports).toBe('0');
    expect(a.receivedRaw).toBe('0');
    expect(ledger.hasCredits(1, A.mint)).toBe(false);
    expect(owedSum(A.mint)).toBe(0n);
    expect(b.error).toBeUndefined();
    expect(owedSum(B.mint) + ledger.getCarry(B.mint)).toBe(RECEIVED[B.mint]);
    expect(ledger.totals().spentLamports).toBe(500_000_000n); // only B's spend
  });

  it('refuses a buy whose re-quote exceeds the impact cap (nothing sent)', async () => {
    setup();
    vi.mocked(jup.getQuoteMeasured).mockImplementation(async (_cfg, p) => ({
      inputMint: p.inputMint,
      outputMint: p.outputMint,
      inAmount: p.amount,
      outAmount: p.amount,
      priceImpactBps: p.outputMint === A.mint ? 900 : 10,
      raw: {},
    }));
    const r = await runRound(ctx);
    expect(r.basket.find((b) => b.mint === A.mint)!.error).toMatch(/impact/);
    expect(vi.mocked(jup.buildSwapTransaction).mock.calls.map((c) => c[1].outputMint)).toEqual([B.mint]);
  });

  it('swap build errors are per-coin refusals; the round still completes', async () => {
    setup();
    vi.mocked(jup.buildSwapTransaction).mockRejectedValue(new Error('jupiter 500'));
    const r = await runRound(ctx);
    expect(r.status).toBe('DONE');
    expect(r.basket.every((b) => b.signature === null && /jupiter 500/.test(b.error ?? ''))).toBe(true);
    expect(rpc.sendAndConfirm).not.toHaveBeenCalled();
    expect(ledger.getOwedMints()).toEqual([]);
  });

  it('marks the round FAILED when an unexpected error happens before any buy is sent', async () => {
    setup();
    ledger.upsertBuy = () => {
      throw new Error('disk full');
    };
    await expect(runRound(ctx)).rejects.toThrow('disk full');
    expect(rpc.sendAndConfirm).not.toHaveBeenCalled();
    expect(ledger.rounds.get(1)!.status).toBe('FAILED');
    expect(ledger.getUnfinishedRound()).toBeNull();
  });
});
