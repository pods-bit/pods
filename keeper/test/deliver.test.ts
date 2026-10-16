import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TransactionInstruction } from '@solana/web3.js';

vi.mock('../src/chain/rpc', () => ({
  getSolBalance: vi.fn(),
  getTokenBalanceRaw: vi.fn(),
  getAtaRentLamports: vi.fn(),
  buildAndSign: vi.fn(),
  sendAndConfirm: vi.fn(),
  signatureStatus: vi.fn(),
  getBlockHeight: vi.fn(),
}));
vi.mock('../src/chain/holders', () => ({ getOwnersWithAta: vi.fn(), snapshotHolders: vi.fn() }));
vi.mock('../src/round/plan', async () => (await import('./fakes')).planImpl);

import * as rpc from '../src/chain/rpc';
import * as holdersMod from '../src/chain/holders';
import { MAX_TX_BYTES, deliverMint, resumeDeliveries } from '../src/round/deliver';
import type { KeeperContext } from '../src/context';
import { FakeLedger, makeCtx, newAddress, testConfig } from './fakes';

const TOKENKEG = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const RENT = 2_039_280n; // at $100/SOL = $0.203928; x1.5 margin = $0.305892
const COIN = { mint: newAddress(), decimals: 6, tokenProgram: TOKENKEG, priceUsd: 1 }; // 1 token = $1
const SOL_USD = 100;

let ledger: FakeLedger;
let ctx: KeeperContext;
let roundId: number;
let built: TransactionInstruction[][];
let sigN: number;
let bytesPerIx: number;

function setup(over: { transfersPerTx?: number; ataCreatesPerTx?: number } = {}) {
  ledger = new FakeLedger();
  ctx = makeCtx({ ledger, cfg: testConfig(over) });
  roundId = ledger.createRound({ startedAt: 1, potLamports: 0n, eligibleWallets: 0, basket: [], rejected: [] });
  built = [];
  sigN = 0;
  bytesPerIx = 100;
  vi.mocked(rpc.getSolBalance).mockResolvedValue(1_000_000_000n);
  vi.mocked(rpc.getTokenBalanceRaw).mockResolvedValue(10n ** 18n);
  vi.mocked(rpc.getAtaRentLamports).mockResolvedValue(RENT);
  vi.mocked(rpc.buildAndSign).mockImplementation(async (_c, _cfg, payer, ixs) => {
    expect(payer).toBe(ctx.signer);
    const size = ixs.length * bytesPerIx;
    if (size > 2048) throw new RangeError('encoding overruns Uint8Array');
    built.push(ixs);
    return {
      tx: { serialize: () => new Uint8Array(size) } as never,
      signature: `dsig${++sigN}`,
      lastValidBlockHeight: 500,
    };
  });
  vi.mocked(rpc.sendAndConfirm).mockResolvedValue('confirmed');
}

function owe(wallets: string[], amount: bigint) {
  for (const w of wallets) ledger.seedOwed(w, COIN.mint, amount);
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('deliverMint', () => {
  it('batches wallets that already have the ATA by transfersPerTx', async () => {
    setup({ transfersPerTx: 2 });
    const ws = Array.from({ length: 5 }, newAddress);
    owe(ws, 1_000n);
    vi.mocked(holdersMod.getOwnersWithAta).mockResolvedValue(new Set(ws));

    const r = await deliverMint(ctx, roundId, COIN, SOL_USD);

    expect(built.map((ixs) => ixs.length)).toEqual([2, 2, 1]);
    expect(r).toEqual({ transfers: 5, signatures: ['dsig1', 'dsig2', 'dsig3'] });
    expect(ledger.getOwedForMint(COIN.mint).size).toBe(0);
    for (const w of ws) expect(ledger.delivered.get(w)!.get(COIN.mint)).toBe(1_000n);
    expect(ledger.getRound(roundId)!.transfersSent).toBe(5);
    expect(ledger.getRound(roundId)!.deliverySignatures).toEqual(['dsig1', 'dsig2', 'dsig3']);
  });

  it('no-ATA wallet below the rent margin waits', async () => {
    setup();
    const w = newAddress();
    owe([w], 300_000n); // $0.30 < $0.305892
    vi.mocked(holdersMod.getOwnersWithAta).mockResolvedValue(new Set());

    const r = await deliverMint(ctx, roundId, COIN, SOL_USD);

    expect(r).toEqual({ transfers: 0, signatures: [] });
    expect(rpc.buildAndSign).not.toHaveBeenCalled();
    expect(ledger.getOwedForMint(COIN.mint).get(w)).toBe(300_000n);
  });

  it('no-ATA wallet above the margin gets an account opened with rent withheld', async () => {
    setup();
    const w = newAddress();
    owe([w], 1_000_000n); // $1
    vi.mocked(holdersMod.getOwnersWithAta).mockResolvedValue(new Set());

    const r = await deliverMint(ctx, roundId, COIN, SOL_USD);

    expect(r.transfers).toBe(1);
    expect(built).toHaveLength(1);
    expect(built[0]).toHaveLength(2); // idempotent ATA create + transferChecked
    expect(built[0]![0]!.programId.toBase58()).toBe('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
    expect(built[0]![1]!.programId.toBase58()).toBe(TOKENKEG);
    const withheld = 203_928n;
    const pending = ledger.deliveries.get('dsig1')!.d;
    expect(pending.items).toEqual([{ wallet: w, amountRaw: 1_000_000n - withheld, rentWithheldRaw: withheld }]);
    expect(ledger.getOwedForMint(COIN.mint).size).toBe(0);
    expect(ledger.delivered.get(w)!.get(COIN.mint)).toBe(1_000_000n - withheld);
    expect(ledger.getCarry(COIN.mint)).toBe(withheld);
  });

  it('sends ATA holders first, then opens, each with its own batch size', async () => {
    setup({ transfersPerTx: 3, ataCreatesPerTx: 2 });
    const has = Array.from({ length: 4 }, newAddress);
    const none = Array.from({ length: 3 }, newAddress);
    owe(has, 10n);
    owe(none, 5_000_000n);
    vi.mocked(holdersMod.getOwnersWithAta).mockResolvedValue(new Set(has));

    const r = await deliverMint(ctx, roundId, COIN, SOL_USD);

    expect(built.map((ixs) => ixs.length)).toEqual([3, 1, 4, 2]); // 3+1 transfers, then 2+1 open pairs
    expect(r.transfers).toBe(7);
  });

  it('records the pending delivery before sending', async () => {
    setup();
    const w = newAddress();
    owe([w], 1_000n);
    vi.mocked(holdersMod.getOwnersWithAta).mockResolvedValue(new Set([w]));
    vi.mocked(rpc.sendAndConfirm).mockImplementation(async () => {
      const p = ledger.getPendingDeliveries();
      expect(p).toHaveLength(1);
      expect(p[0]).toMatchObject({ signature: 'dsig1', roundId, mint: COIN.mint, lastValidBlockHeight: 500 });
      expect(ledger.getOwedForMint(COIN.mint).get(w)).toBe(1_000n); // not decremented yet
      return 'confirmed';
    });
    await deliverMint(ctx, roundId, COIN, SOL_USD);
    expect(rpc.sendAndConfirm).toHaveBeenCalledTimes(1);
    expect(ledger.getPendingDeliveries()).toHaveLength(0);
  });

  it('a failed tx is recorded with failDelivery and owed is kept', async () => {
    setup({ transfersPerTx: 1 });
    const ws = [newAddress(), newAddress()];
    owe(ws, 1_000n);
    vi.mocked(holdersMod.getOwnersWithAta).mockResolvedValue(new Set(ws));
    vi.mocked(rpc.sendAndConfirm).mockResolvedValue('failed');

    const r = await deliverMint(ctx, roundId, COIN, SOL_USD);

    expect(r).toEqual({ transfers: 0, signatures: [] });
    expect(ledger.deliveries.get('dsig1')).toMatchObject({ state: 'FAILED', reason: 'failed' });
    expect(rpc.sendAndConfirm).toHaveBeenCalledTimes(1); // stops this mint after a failure
    expect(ledger.getOwedForMint(COIN.mint).size).toBe(2);
  });

  it('a transport error while sending leaves the delivery pending (no failDelivery)', async () => {
    setup();
    const w = newAddress();
    owe([w], 1_000n);
    vi.mocked(holdersMod.getOwnersWithAta).mockResolvedValue(new Set([w]));
    vi.mocked(rpc.sendAndConfirm).mockRejectedValue(new Error('ECONNRESET'));
    await expect(deliverMint(ctx, roundId, COIN, SOL_USD)).rejects.toThrow('ECONNRESET');
    expect(ledger.getPendingDeliveries()).toHaveLength(1);

    // while it is unsettled, the mint is not delivered again (no double pay)
    vi.mocked(rpc.sendAndConfirm).mockResolvedValue('confirmed');
    const r = await deliverMint(ctx, roundId, COIN, SOL_USD);
    expect(r.transfers).toBe(0);
    expect(rpc.buildAndSign).toHaveBeenCalledTimes(1);
  });

  it("an 'expired' tx that confirms late is confirmed, not failed (no double pay)", async () => {
    setup();
    const w = newAddress();
    owe([w], 1_000n);
    vi.mocked(holdersMod.getOwnersWithAta).mockResolvedValue(new Set([w]));
    vi.mocked(rpc.sendAndConfirm).mockResolvedValue('expired');
    vi.mocked(rpc.getBlockHeight).mockResolvedValue(10_000);
    vi.mocked(rpc.signatureStatus).mockResolvedValue('confirmed');

    const r = await deliverMint(ctx, roundId, COIN, SOL_USD);

    expect(r.transfers).toBe(1);
    expect(ledger.deliveries.get('dsig1')!.state).toBe('CONFIRMED');
    expect(ledger.getOwedForMint(COIN.mint).size).toBe(0);
  });

  it("an 'expired' tx still unseen past the margin is failed and owed kept", async () => {
    setup();
    const w = newAddress();
    owe([w], 1_000n);
    vi.mocked(holdersMod.getOwnersWithAta).mockResolvedValue(new Set([w]));
    vi.mocked(rpc.sendAndConfirm).mockResolvedValue('expired');
    vi.mocked(rpc.getBlockHeight).mockResolvedValue(10_000);
    vi.mocked(rpc.signatureStatus).mockResolvedValue('unknown');

    const r = await deliverMint(ctx, roundId, COIN, SOL_USD);

    expect(r.transfers).toBe(0);
    expect(ledger.deliveries.get('dsig1')).toMatchObject({ state: 'FAILED', reason: 'expired' });
    expect(ledger.getOwedForMint(COIN.mint).get(w)).toBe(1_000n);
  });

  it('stops when keeper SOL is below the operating reserve', async () => {
    setup();
    const w = newAddress();
    owe([w], 1_000n);
    vi.mocked(holdersMod.getOwnersWithAta).mockResolvedValue(new Set([w]));
    vi.mocked(rpc.getSolBalance).mockResolvedValue(10_000_000n); // 0.01 < 0.05 reserve

    const r = await deliverMint(ctx, roundId, COIN, SOL_USD);

    expect(r.transfers).toBe(0);
    expect(rpc.buildAndSign).not.toHaveBeenCalled();
    expect(ledger.writes).toBe(1); // only the createRound from setup
  });

  it('stops mid-way when SOL drops below the reserve between batches', async () => {
    setup({ transfersPerTx: 1 });
    const ws = [newAddress(), newAddress(), newAddress()];
    owe(ws, 1_000n);
    vi.mocked(holdersMod.getOwnersWithAta).mockResolvedValue(new Set(ws));
    vi.mocked(rpc.getSolBalance).mockResolvedValueOnce(1_000_000_000n).mockResolvedValue(1n);
    const r = await deliverMint(ctx, roundId, COIN, SOL_USD);
    expect(r.transfers).toBe(1);
  });

  it('halves a batch that does not fit in one transaction', async () => {
    setup({ transfersPerTx: 8 });
    const ws = Array.from({ length: 8 }, newAddress);
    owe(ws, 1_000n);
    vi.mocked(holdersMod.getOwnersWithAta).mockResolvedValue(new Set(ws));
    bytesPerIx = 300; // 8 ixs = 2400 B (throws), 4 ixs = 1200 B (fits)

    const r = await deliverMint(ctx, roundId, COIN, SOL_USD);

    expect(built.map((ixs) => ixs.length)).toEqual([4, 4]);
    expect(r.transfers).toBe(8);
    expect(4 * bytesPerIx).toBeLessThanOrEqual(MAX_TX_BYTES);
  });

  it('never transfers more than the keeper holds', async () => {
    setup();
    const ws = [newAddress(), newAddress()];
    ledger.seedOwed(ws[0]!, COIN.mint, 700n);
    ledger.seedOwed(ws[1]!, COIN.mint, 500n);
    vi.mocked(holdersMod.getOwnersWithAta).mockResolvedValue(new Set(ws));
    vi.mocked(rpc.getTokenBalanceRaw).mockResolvedValue(1_000n);

    const r = await deliverMint(ctx, roundId, COIN, SOL_USD);

    expect(r.transfers).toBe(1);
    expect(ledger.getOwedForMint(COIN.mint).get(ws[1]!)).toBe(500n);
  });

  it('does nothing in dry-run', async () => {
    setup();
    ctx = { ...ctx, dryRun: true };
    owe([newAddress()], 1_000n);
    const r = await deliverMint(ctx, roundId, COIN, SOL_USD);
    expect(r.transfers).toBe(0);
    expect(holdersMod.getOwnersWithAta).not.toHaveBeenCalled();
  });
});

describe('resumeDeliveries', () => {
  it('confirms landed txs, fails expired/failed ones, leaves still-valid unknown ones pending', async () => {
    setup();
    const item = (w: string) => [{ wallet: w, amountRaw: 10n, rentWithheldRaw: 0n }];
    const [w1, w2, w3, w4] = [newAddress(), newAddress(), newAddress(), newAddress()];
    owe([w1, w2, w3, w4], 10n);
    ledger.recordPendingDelivery({ signature: 's-ok', roundId, mint: COIN.mint, lastValidBlockHeight: 100, items: item(w1) });
    ledger.recordPendingDelivery({ signature: 's-fail', roundId, mint: COIN.mint, lastValidBlockHeight: 100, items: item(w2) });
    ledger.recordPendingDelivery({ signature: 's-exp', roundId, mint: COIN.mint, lastValidBlockHeight: 40, items: item(w3) });
    // past its lastValidBlockHeight but within the safety margin: still pending
    ledger.recordPendingDelivery({ signature: 's-wait', roundId, mint: COIN.mint, lastValidBlockHeight: 100, items: item(w4) });
    vi.mocked(rpc.getBlockHeight).mockResolvedValue(200);
    vi.mocked(rpc.signatureStatus).mockImplementation(async (_c, s) =>
      s === 's-ok' ? 'confirmed' : s === 's-fail' ? 'failed' : 'unknown',
    );

    await resumeDeliveries(ctx);

    expect(ledger.deliveries.get('s-ok')!.state).toBe('CONFIRMED');
    expect(ledger.deliveries.get('s-fail')!.state).toBe('FAILED');
    expect(ledger.deliveries.get('s-exp')).toMatchObject({ state: 'FAILED', reason: 'expired' });
    expect(ledger.deliveries.get('s-wait')!.state).toBe('PENDING');
    expect(ledger.getOwedForMint(COIN.mint).has(w1)).toBe(false);
    expect(ledger.getOwedForMint(COIN.mint).get(w2)).toBe(10n);
  });
});
