import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../src/ledger/db';
import type { BasketCoin } from '../../shared/types';

const MINT_A = 'MintA';
const MINT_B = 'MintB';

const coin = (mint: string): BasketCoin => ({
  mint, symbol: mint.toUpperCase(), name: mint, image: '', pool: 'pool', decimals: 6,
  tokenProgram: 'Tokenkeg', priceUsd: 0.01, marketCapUsd: 1, liquidityUsd: 1, volume24hUsd: 1, change24h: 0, holders: 1,
});

function newRound(l: Ledger, startedAt = 1000, extra: Partial<Parameters<Ledger['createRound']>[0]> = {}) {
  return l.createRound({
    startedAt, potLamports: 1_000_000_000n, eligibleWallets: 3, basket: [coin(MINT_A)], rejected: [], ...extra,
  });
}

function buy(l: Ledger, roundId: number, mint = MINT_A, o: Record<string, unknown> = {}) {
  l.upsertBuy({
    roundId, mint, symbol: 'A', decimals: 6, tokenProgram: 'Tokenkeg', spentLamports: 500n,
    state: 'CONFIRMED', signature: 'sigbuy', lastValidBlockHeight: 99, receivedRaw: 1000n, ...o,
  });
}

describe('Ledger', () => {
  let l: Ledger;
  beforeEach(() => { l = new Ledger(':memory:'); });
  afterEach(() => { l.close(); });

  it('round lifecycle', () => {
    const id = newRound(l);
    const r = l.getRound(id)!;
    expect(r).toMatchObject({
      id, startedAt: 1000, finishedAt: null, status: 'PLANNED', potLamports: '1000000000',
      eligibleWallets: 3, basket: [], transfersSent: 0, deliverySignatures: [],
    });
    expect(r.skippedReason).toBeUndefined();
    expect(l.getRoundBasket(id)).toEqual([coin(MINT_A)]);
    expect(l.getUnfinishedRound()!.id).toBe(id);
    l.setRoundStatus(id, 'BOUGHT');
    expect(l.getRound(id)!.status).toBe('BOUGHT');
    expect(l.getUnfinishedRound()!.id).toBe(id);
    l.setRoundStatus(id, 'DONE', { finishedAt: 2000 });
    expect(l.getRound(id)).toMatchObject({ status: 'DONE', finishedAt: 2000 });
    expect(l.getUnfinishedRound()).toBeNull();
    expect(l.getRound(999)).toBeNull();
    expect(l.getRoundBasket(999)).toEqual([]);
  });

  it('skipped round carries reason and is not unfinished', () => {
    const id = newRound(l, 5000, { status: 'SKIPPED', skippedReason: 'pot too small' });
    expect(l.getRound(id)).toMatchObject({ status: 'SKIPPED', skippedReason: 'pot too small', finishedAt: 5000 });
    expect(l.getUnfinishedRound()).toBeNull();
  });

  it('setRoundStatus supports skippedReason and throws for unknown round', () => {
    const id = newRound(l);
    l.setRoundStatus(id, 'SKIPPED', { skippedReason: 'no basket', finishedAt: 1500 });
    expect(l.getRound(id)).toMatchObject({ skippedReason: 'no basket', finishedAt: 1500 });
    expect(() => l.setRoundStatus(12345, 'DONE')).toThrow();
  });

  it('getUnfinishedRound returns the most recent unfinished', () => {
    const a = newRound(l, 1);
    const b = newRound(l, 2);
    l.setRoundStatus(a, 'DELIVERING');
    l.setRoundStatus(b, 'CREDITED');
    expect(l.getUnfinishedRound()!.id).toBe(b);
  });

  it('buys upsert replaces and defaults', () => {
    const id = newRound(l);
    l.upsertBuy({
      roundId: id, mint: MINT_A, symbol: 'A', decimals: 6, tokenProgram: 'Tokenkeg', spentLamports: 500n,
      state: 'SENT', signature: 's1', lastValidBlockHeight: 10,
    });
    expect(l.getBuys(id)).toEqual([
      expect.objectContaining({ state: 'SENT', receivedRaw: 0n, error: null, lastValidBlockHeight: 10, spentLamports: 500n }),
    ]);
    buy(l, id, MINT_A, { signature: 's1' });
    const rows = l.getBuys(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'CONFIRMED', receivedRaw: 1000n });
    l.upsertBuy({
      roundId: id, mint: MINT_B, symbol: 'B', decimals: 9, tokenProgram: 'T22', spentLamports: 1n,
      state: 'FAILED', signature: null, lastValidBlockHeight: null, error: 'boom',
    });
    expect(l.getBuys(id)).toHaveLength(2);
    expect(l.getBuys(id)[1]).toMatchObject({ error: 'boom', signature: null, lastValidBlockHeight: null });
  });

  it('applyCredits credits owed, sets carry, and is idempotent', () => {
    const id = newRound(l);
    expect(l.hasCredits(id, MINT_A)).toBe(false);
    const credits = new Map([['w1', 600n], ['w2', 399n]]);
    l.applyCredits(id, MINT_A, credits, 1n);
    expect(l.hasCredits(id, MINT_A)).toBe(true);
    expect(l.getOwedForMint(MINT_A)).toEqual(credits);
    expect(l.getCarry(MINT_A)).toBe(1n);
    l.applyCredits(id, MINT_A, credits, 7n); // no-op
    expect(l.getOwedForMint(MINT_A)).toEqual(credits);
    expect(l.getCarry(MINT_A)).toBe(1n);
    // next round accumulates
    const id2 = newRound(l, 2000);
    l.applyCredits(id2, MINT_A, new Map([['w1', 10n]]), 2n);
    expect(l.getOwedForMint(MINT_A).get('w1')).toBe(610n);
    expect(l.getCarry(MINT_A)).toBe(2n);
  });

  it('applyCredits with empty credits still sets carry and marks applied', () => {
    const id = newRound(l);
    l.applyCredits(id, MINT_A, new Map(), 500n);
    expect(l.hasCredits(id, MINT_A)).toBe(true);
    expect(l.getCarry(MINT_A)).toBe(500n);
    l.applyCredits(id, MINT_A, new Map(), 900n);
    expect(l.getCarry(MINT_A)).toBe(500n);
  });

  it('carry add/get', () => {
    expect(l.getCarry(MINT_A)).toBe(0n);
    l.addCarry(MINT_A, 5n);
    l.addCarry(MINT_A, 6n);
    expect(l.getCarry(MINT_A)).toBe(11n);
    expect(() => l.addCarry(MINT_A, -12n)).toThrow();
    expect(l.getCarry(MINT_A)).toBe(11n);
  });

  describe('deliveries', () => {
    let id: number;
    beforeEach(() => {
      id = newRound(l);
      buy(l, id);
      l.applyCredits(id, MINT_A, new Map([['w1', 600n], ['w2', 300n], ['w3', 50n]]), 50n);
      l.setRoundStatus(id, 'DELIVERING');
    });

    const pending = (sig = 'sig1') => ({
      signature: sig, roundId: id, mint: MINT_A, lastValidBlockHeight: 123,
      items: [
        { wallet: 'w1', amountRaw: 600n, rentWithheldRaw: 0n },
        { wallet: 'w2', amountRaw: 250n, rentWithheldRaw: 50n },
      ],
    });

    it('record -> pending list round-trips bigint', () => {
      l.recordPendingDelivery(pending());
      expect(l.getPendingDeliveries()).toEqual([pending()]);
      expect(l.getOwedForMint(MINT_A).get('w1')).toBe(600n); // untouched
    });

    it('confirm updates owed, delivered, carry, transfers, sigs', () => {
      l.recordPendingDelivery(pending());
      l.confirmDelivery('sig1');
      expect(l.getOwedForMint(MINT_A)).toEqual(new Map([['w3', 50n]]));
      expect(l.getCarry(MINT_A)).toBe(100n); // 50 dust + 50 rent
      const r = l.getRound(id)!;
      expect(r.transfersSent).toBe(2);
      expect(r.deliverySignatures).toEqual(['sig1']);
      expect(l.getPendingDeliveries()).toEqual([]);
      const snap = l.owedSnapshot(777);
      expect(snap).toEqual({
        updatedAt: 777,
        owed: { w3: { [MINT_A]: '50' } },
        delivered: { w1: { [MINT_A]: '600' }, w2: { [MINT_A]: '250' } },
      });
      expect(l.getOwedMints()).toEqual([MINT_A]);
    });

    it('confirm is idempotent', () => {
      l.recordPendingDelivery(pending());
      l.confirmDelivery('sig1');
      l.confirmDelivery('sig1');
      expect(l.getOwedForMint(MINT_A)).toEqual(new Map([['w3', 50n]]));
      expect(l.getCarry(MINT_A)).toBe(100n);
      expect(l.getRound(id)!.transfersSent).toBe(2);
      expect(l.getRound(id)!.deliverySignatures).toEqual(['sig1']);
      expect(l.owedSnapshot(0).delivered.w1![MINT_A]).toBe('600');
    });

    it('re-recording a confirmed signature does not reset it', () => {
      l.recordPendingDelivery(pending());
      l.confirmDelivery('sig1');
      l.recordPendingDelivery(pending());
      expect(l.getPendingDeliveries()).toEqual([]);
      l.confirmDelivery('sig1');
      expect(l.getCarry(MINT_A)).toBe(100n);
    });

    it('fail leaves owed untouched and removes from pending', () => {
      l.recordPendingDelivery(pending());
      l.failDelivery('sig1', 'expired');
      expect(l.getPendingDeliveries()).toEqual([]);
      expect(l.getOwedForMint(MINT_A).get('w1')).toBe(600n);
      expect(l.getCarry(MINT_A)).toBe(50n);
      expect(l.getRound(id)!.transfersSent).toBe(0);
      expect(l.owedSnapshot(0).delivered).toEqual({});
    });

    it('fail after confirm is a no-op', () => {
      l.recordPendingDelivery(pending());
      l.confirmDelivery('sig1');
      l.failDelivery('sig1', 'late');
      l.confirmDelivery('sig1');
      expect(l.getOwedForMint(MINT_A)).toEqual(new Map([['w3', 50n]]));
    });

    it('a failed delivery that later lands can still be confirmed', () => {
      l.recordPendingDelivery(pending());
      l.failDelivery('sig1', 'timeout');
      l.confirmDelivery('sig1');
      expect(l.getOwedForMint(MINT_A)).toEqual(new Map([['w3', 50n]]));
    });

    it('owed never goes negative: throws and rolls back everything', () => {
      l.recordPendingDelivery({
        signature: 'bad', roundId: id, mint: MINT_A, lastValidBlockHeight: 1,
        items: [
          { wallet: 'w1', amountRaw: 100n, rentWithheldRaw: 0n }, // fine on its own
          { wallet: 'w3', amountRaw: 51n, rentWithheldRaw: 0n }, // exceeds owed 50
        ],
      });
      expect(() => l.confirmDelivery('bad')).toThrow(/negative/);
      expect(l.getOwedForMint(MINT_A).get('w1')).toBe(600n); // rolled back
      expect(l.getOwedForMint(MINT_A).get('w3')).toBe(50n);
      expect(l.getCarry(MINT_A)).toBe(50n);
      expect(l.getRound(id)!.transfersSent).toBe(0);
      expect(l.getPendingDeliveries().map((d) => d.signature)).toEqual(['bad']);
      expect(l.owedSnapshot(0).delivered).toEqual({});
    });

    it('amount + rent exceeding owed also throws', () => {
      l.recordPendingDelivery({
        signature: 'bad2', roundId: id, mint: MINT_A, lastValidBlockHeight: 1,
        items: [{ wallet: 'w3', amountRaw: 40n, rentWithheldRaw: 11n }],
      });
      expect(() => l.confirmDelivery('bad2')).toThrow(/negative/);
    });

    it('unknown signature throws', () => {
      expect(() => l.confirmDelivery('nope')).toThrow();
    });

    it('getOwedMints drops mints once fully delivered', () => {
      l.recordPendingDelivery({
        signature: 'all', roundId: id, mint: MINT_A, lastValidBlockHeight: 1,
        items: [
          { wallet: 'w1', amountRaw: 600n, rentWithheldRaw: 0n },
          { wallet: 'w2', amountRaw: 300n, rentWithheldRaw: 0n },
          { wallet: 'w3', amountRaw: 50n, rentWithheldRaw: 0n },
        ],
      });
      l.confirmDelivery('all');
      expect(l.getOwedMints()).toEqual([]);
      expect(l.getOwedForMint(MINT_A).size).toBe(0);
      expect(l.owedSnapshot(0).owed).toEqual({});
    });

    it('totals', () => {
      l.recordPendingDelivery(pending('s1'));
      l.confirmDelivery('s1');
      l.setRoundStatus(id, 'DONE', { finishedAt: 10 });
      newRound(l, 3000, { status: 'SKIPPED', skippedReason: 'x' });
      const t = l.totals();
      expect(t).toEqual({ rounds: 2, roundsRun: 1, spentLamports: 500n, transfersSent: 2, walletsPaid: 2 });
    });
  });

  it('totals on empty ledger', () => {
    expect(l.totals()).toEqual({ rounds: 0, roundsRun: 0, spentLamports: 0n, transfersSent: 0, walletsPaid: 0 });
  });

  it('totals count only CONFIRMED buys as spent', () => {
    const id = newRound(l);
    buy(l, id, MINT_A, { spentLamports: 100n });
    buy(l, id, MINT_B, { spentLamports: 900n, state: 'FAILED' });
    expect(l.totals().spentLamports).toBe(100n);
  });

  it('listRounds newest first with basket from buys', () => {
    const r1 = newRound(l, 100);
    const r2 = newRound(l, 200);
    const r3 = newRound(l, 300);
    buy(l, r2, MINT_A, { error: 'partial' });
    buy(l, r2, MINT_B, { spentLamports: 7n, receivedRaw: 70n, signature: null });
    const list = l.listRounds(2);
    expect(list.map((r) => r.id)).toEqual([r3, r2]);
    expect(list[1]!.basket).toEqual([
      { mint: MINT_A, symbol: 'A', decimals: 6, spentLamports: '500', receivedRaw: '1000', signature: 'sigbuy', error: 'partial' },
      { mint: MINT_B, symbol: 'A', decimals: 6, spentLamports: '7', receivedRaw: '70', signature: null },
    ]);
    expect(list[0]!.basket).toEqual([]);
    expect(l.listRounds(10).map((r) => r.id)).toEqual([r3, r2, r1]);
  });

  it('meta get/set/overwrite', () => {
    expect(l.getMeta('k')).toBeNull();
    l.setMeta('k', 'v1');
    l.setMeta('k', 'v2');
    expect(l.getMeta('k')).toBe('v2');
  });

  it('persists to a file DB (WAL) and reopens', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod5-ledger-'));
    try {
      const path = join(dir, 'nested', 'k.db');
      const f = new Ledger(path);
      const id = newRound(f);
      f.applyCredits(id, MINT_A, new Map([['w', 5n]]), 1n);
      f.setMeta('a', 'b');
      f.close();
      const g = new Ledger(path);
      expect(g.getOwedForMint(MINT_A).get('w')).toBe(5n);
      expect(g.getCarry(MINT_A)).toBe(1n);
      expect(g.getMeta('a')).toBe('b');
      expect(g.getRound(id)).not.toBeNull();
      g.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
