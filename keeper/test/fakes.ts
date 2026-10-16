// In-memory test doubles. FakeLedger mirrors the public contract of src/ledger/db.ts (per its
// doc comments) so runner/deliver tests do not depend on the SQLite implementation.
import { Keypair, PublicKey } from '@solana/web3.js';
import type { Config } from '../src/config';
import type { KeeperContext } from '../src/context';
import type { BuyRow, DeliveryItem, Ledger, PendingDelivery } from '../src/ledger/db';
import type { Logger } from '../src/log';
import type { DeliveryAction, Holder } from '../src/round/plan';
import type {
  BasketCoin,
  OwedSnapshot,
  RejectedCoin,
  RoundBuyReceipt,
  RoundReceipt,
  RoundStatus,
} from '../../shared/types';

interface RoundRec {
  id: number;
  startedAt: number;
  finishedAt: number | null;
  status: RoundStatus;
  skippedReason?: string;
  potLamports: bigint;
  eligibleWallets: number;
  basket: BasketCoin[];
  rejected: RejectedCoin[];
  transfersSent: number;
  deliverySignatures: string[];
}

interface DeliveryRec {
  d: PendingDelivery;
  state: 'PENDING' | 'CONFIRMED' | 'FAILED';
  reason?: string;
}

function bump(m: Map<string, Map<string, bigint>>, wallet: string, mint: string, delta: bigint): void {
  let inner = m.get(wallet);
  if (!inner) m.set(wallet, (inner = new Map()));
  inner.set(mint, (inner.get(mint) ?? 0n) + delta);
}

export class FakeLedger {
  /** Number of mutating calls (dry-run tests assert this stays 0). */
  writes = 0;
  /** Names of mutating calls in order. */
  writeLog: string[] = [];
  rounds = new Map<number, RoundRec>();
  buys = new Map<string, BuyRow>();
  carry = new Map<string, bigint>();
  credits = new Map<string, Map<string, bigint>>(); // `${roundId}|${mint}` -> credits
  owed = new Map<string, Map<string, bigint>>();
  delivered = new Map<string, Map<string, bigint>>();
  deliveries = new Map<string, DeliveryRec>();
  meta = new Map<string, string>();
  private nextId = 1;

  private w(name: string): void {
    this.writes++;
    this.writeLog.push(name);
  }

  asLedger(): Ledger {
    return this as unknown as Ledger;
  }

  close(): void {}

  // ---- rounds ----
  createRound(r: {
    startedAt: number;
    potLamports: bigint;
    eligibleWallets: number;
    basket: BasketCoin[];
    rejected: RejectedCoin[];
    status?: RoundStatus;
    skippedReason?: string;
  }): number {
    this.w('createRound');
    const id = this.nextId++;
    this.rounds.set(id, {
      id,
      startedAt: r.startedAt,
      finishedAt: null,
      status: r.status ?? 'PLANNED',
      skippedReason: r.skippedReason,
      potLamports: r.potLamports,
      eligibleWallets: r.eligibleWallets,
      basket: r.basket,
      rejected: r.rejected,
      transfersSent: 0,
      deliverySignatures: [],
    });
    return id;
  }

  setRoundStatus(id: number, status: RoundStatus, extra?: { skippedReason?: string; finishedAt?: number }): void {
    this.w('setRoundStatus');
    const r = this.rounds.get(id);
    if (!r) throw new Error(`no round ${id}`);
    r.status = status;
    if (extra?.skippedReason !== undefined) r.skippedReason = extra.skippedReason;
    if (extra?.finishedAt !== undefined) r.finishedAt = extra.finishedAt;
  }

  private receipt(r: RoundRec): RoundReceipt {
    const basket: RoundBuyReceipt[] = this.getBuys(r.id).map((b) => {
      const x: RoundBuyReceipt = {
        mint: b.mint,
        symbol: b.symbol,
        decimals: b.decimals,
        spentLamports: b.spentLamports.toString(),
        receivedRaw: b.receivedRaw.toString(),
        signature: b.signature,
      };
      if (b.error) x.error = b.error;
      return x;
    });
    const out: RoundReceipt = {
      id: r.id,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      status: r.status,
      potLamports: r.potLamports.toString(),
      eligibleWallets: r.eligibleWallets,
      basket,
      transfersSent: r.transfersSent,
      deliverySignatures: [...r.deliverySignatures],
    };
    if (r.skippedReason) out.skippedReason = r.skippedReason;
    return out;
  }

  getRound(id: number): RoundReceipt | null {
    const r = this.rounds.get(id);
    return r ? this.receipt(r) : null;
  }

  getRoundBasket(id: number): BasketCoin[] {
    return this.rounds.get(id)?.basket ?? [];
  }

  getUnfinishedRound(): RoundReceipt | null {
    const open = [...this.rounds.values()]
      .filter((r) => ['PLANNED', 'BOUGHT', 'CREDITED', 'DELIVERING'].includes(r.status))
      .sort((a, b) => b.id - a.id);
    return open[0] ? this.receipt(open[0]) : null;
  }

  listRounds(limit: number): RoundReceipt[] {
    return [...this.rounds.values()]
      .sort((a, b) => b.id - a.id)
      .slice(0, limit)
      .map((r) => this.receipt(r));
  }

  // ---- buys ----
  upsertBuy(b: Omit<BuyRow, 'receivedRaw' | 'error'> & { receivedRaw?: bigint; error?: string | null }): void {
    this.w('upsertBuy');
    this.buys.set(`${b.roundId}|${b.mint}`, {
      ...b,
      receivedRaw: b.receivedRaw ?? 0n,
      error: b.error ?? null,
    });
  }

  getBuys(roundId: number): BuyRow[] {
    return [...this.buys.values()].filter((b) => b.roundId === roundId).map((b) => ({ ...b }));
  }

  // ---- carry & credits ----
  getCarry(mint: string): bigint {
    return this.carry.get(mint) ?? 0n;
  }

  addCarry(mint: string, amountRaw: bigint): void {
    this.w('addCarry');
    this.carry.set(mint, this.getCarry(mint) + amountRaw);
  }

  applyCredits(roundId: number, mint: string, credits: Map<string, bigint>, newCarry: bigint): void {
    const key = `${roundId}|${mint}`;
    if (this.credits.has(key)) return;
    this.w('applyCredits');
    this.credits.set(key, new Map(credits));
    for (const [wallet, amt] of credits) bump(this.owed, wallet, mint, amt);
    this.carry.set(mint, newCarry);
  }

  hasCredits(roundId: number, mint: string): boolean {
    return this.credits.has(`${roundId}|${mint}`);
  }

  getOwedForMint(mint: string): Map<string, bigint> {
    const out = new Map<string, bigint>();
    for (const [wallet, m] of this.owed) {
      const v = m.get(mint) ?? 0n;
      if (v > 0n) out.set(wallet, v);
    }
    return out;
  }

  getOwedMints(): string[] {
    const s = new Set<string>();
    for (const m of this.owed.values()) for (const [mint, v] of m) if (v > 0n) s.add(mint);
    return [...s].sort();
  }

  /** Test helper: seed an owed balance without a round. */
  seedOwed(wallet: string, mint: string, amount: bigint): void {
    bump(this.owed, wallet, mint, amount);
  }

  // ---- deliveries ----
  recordPendingDelivery(d: PendingDelivery): void {
    this.w('recordPendingDelivery');
    this.deliveries.set(d.signature, { d: { ...d, items: d.items.map((i) => ({ ...i })) }, state: 'PENDING' });
  }

  confirmDelivery(signature: string): void {
    const rec = this.deliveries.get(signature);
    if (!rec) throw new Error(`unknown delivery ${signature}`);
    if (rec.state === 'CONFIRMED') return;
    this.w('confirmDelivery');
    let withheld = 0n;
    for (const it of rec.d.items) {
      bump(this.owed, it.wallet, rec.d.mint, -(it.amountRaw + it.rentWithheldRaw));
      bump(this.delivered, it.wallet, rec.d.mint, it.amountRaw);
      withheld += it.rentWithheldRaw;
    }
    this.carry.set(rec.d.mint, this.getCarry(rec.d.mint) + withheld);
    const r = this.rounds.get(rec.d.roundId);
    if (r) {
      r.transfersSent += rec.d.items.length;
      r.deliverySignatures.push(signature);
    }
    rec.state = 'CONFIRMED';
  }

  failDelivery(signature: string, reason: string): void {
    this.w('failDelivery');
    const rec = this.deliveries.get(signature);
    if (!rec) throw new Error(`unknown delivery ${signature}`);
    rec.state = 'FAILED';
    rec.reason = reason;
  }

  getPendingDeliveries(): PendingDelivery[] {
    return [...this.deliveries.values()].filter((r) => r.state === 'PENDING').map((r) => r.d);
  }

  // ---- reporting ----
  totals(): { rounds: number; roundsRun: number; spentLamports: bigint; transfersSent: number; walletsPaid: number } {
    let spent = 0n;
    for (const b of this.buys.values()) if (b.state === 'CONFIRMED') spent += b.spentLamports;
    const rounds = [...this.rounds.values()];
    let paid = 0;
    for (const m of this.delivered.values()) if ([...m.values()].some((v) => v > 0n)) paid++;
    return {
      rounds: rounds.length,
      roundsRun: rounds.filter((r) => r.status === 'DONE').length,
      spentLamports: spent,
      transfersSent: rounds.reduce((s, r) => s + r.transfersSent, 0),
      walletsPaid: paid,
    };
  }

  owedSnapshot(nowSec: number): OwedSnapshot {
    const conv = (m: Map<string, Map<string, bigint>>) => {
      const out: Record<string, Record<string, string>> = {};
      for (const [w, inner] of m) {
        for (const [mint, v] of inner) {
          if (v > 0n) (out[w] ??= {})[mint] = v.toString();
        }
      }
      return out;
    };
    return { updatedAt: nowSec, owed: conv(this.owed), delivered: conv(this.delivered) };
  }

  // ---- meta ----
  getMeta(key: string): string | null {
    return this.meta.get(key) ?? null;
  }

  setMeta(key: string, value: string): void {
    this.w('setMeta');
    this.meta.set(key, value);
  }
}

// ---------------------------------------------------------------------------------------------
// Reference implementations of src/round/plan.ts (per its doc comments) for vi.mock factories,
// so these tests do not depend on the real plan.ts implementation.

export const planImpl = {
  computePot(p: {
    balanceLamports: bigint;
    opReserveLamports: bigint;
    estFeesLamports: bigint;
    potCapLamports: bigint | null;
    minPotLamports: bigint;
  }): { pot: bigint; skip: string | null } {
    let pot = p.balanceLamports - p.opReserveLamports - p.estFeesLamports;
    if (pot < 0n) pot = 0n;
    if (p.potCapLamports !== null && pot > p.potCapLamports) pot = p.potCapLamports;
    return { pot, skip: pot < p.minPotLamports ? `pot ${pot} below minimum ${p.minPotLamports}` : null };
  },
  sliceAmounts(pot: bigint, caps: bigint[]): { slices: bigint[]; unspent: bigint } {
    if (caps.length === 0) return { slices: [], unspent: pot };
    const each = pot / BigInt(caps.length);
    const slices = caps.map((c) => (each < c ? each : c));
    return { slices, unspent: pot - slices.reduce((s, x) => s + x, 0n) };
  },
  liquidityCapLamports(liquidityUsd: number, maxSliceOfLiq: number, solUsd: number): bigint {
    if (!(solUsd > 0)) return 0n;
    return BigInt(Math.floor(((liquidityUsd * maxSliceOfLiq) / solUsd) * 1e9));
  },
  qualifyHolders(holders: Holder[], p: { priceUsd: number; decimals: number; minHoldUsd: number }): Holder[] {
    return holders.filter((h) => (Number(h.amountRaw) / 10 ** p.decimals) * p.priceUsd >= p.minHoldUsd);
  },
  allocateProRata(totalRaw: bigint, holders: Holder[]): { credits: Map<string, bigint>; dust: bigint } {
    const credits = new Map<string, bigint>();
    const sum = holders.reduce((s, h) => s + h.amountRaw, 0n);
    if (sum === 0n) return { credits, dust: totalRaw };
    let given = 0n;
    for (const h of holders) {
      const c = (totalRaw * h.amountRaw) / sum;
      if (c > 0n) {
        credits.set(h.owner, (credits.get(h.owner) ?? 0n) + c);
        given += c;
      }
    }
    return { credits, dust: totalRaw - given };
  },
  deliveryDecision(p: {
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
    if (p.tokenPriceUsd <= 0 || p.solUsd <= 0) return { kind: 'wait' };
    const value = (Number(p.owedRaw) / 10 ** p.decimals) * p.tokenPriceUsd;
    const rentUsd = (Number(p.rentLamports) * p.solUsd) / 1e9;
    if (value < rentUsd * p.rentMargin) return { kind: 'wait' };
    const withheld = BigInt(Math.ceil((rentUsd / p.tokenPriceUsd) * 10 ** p.decimals));
    return { kind: 'open', amountRaw: p.owedRaw - withheld, rentWithheldRaw: withheld };
  },
  estimateRoundFees(_p: { coins: number; recipients: number; transfersPerTx: number; priorityFeeMicroLamports: number }): bigint {
    return 1_000_000n; // 0.001 SOL, fixed for tests
  },
};

// ---------------------------------------------------------------------------------------------

export function testConfig(over: Partial<Config> = {}): Config {
  return {
    cluster: 'localnet',
    rpcUrl: 'http://127.0.0.1:8899',
    keeperKeypairPath: null,
    keeperPubkey: null,
    pod5Mint: newAddress(),
    podApiBase: 'http://pod.test',
    jupiterApiBase: 'http://jup.test',
    jupiterApiKey: null,
    dbPath: ':memory:',
    publishDir: '/nonexistent-publish-dir',
    excludeWallets: [],
    excludeMints: [],
    roundIntervalMin: 15,
    minPotLamports: 50_000_000n,
    opReserveLamports: 50_000_000n,
    potCapLamports: null,
    minHoldUsd: 30,
    maxCoins: 5,
    minLiqUsd: 5000,
    maxSliceOfLiq: 0.01,
    maxImpactBps: 300,
    slippageBps: 300,
    minHolders: 50,
    minVol24hUsd: 1000,
    minTrades24h: 20,
    minAgeHours: 24,
    rentMargin: 1.5,
    transfersPerTx: 18,
    ataCreatesPerTx: 8,
    priorityFeeMicroLamports: 50_000,
    alertWebhookUrl: null,
    ...over,
  };
}

export function newAddress(): string {
  return Keypair.generate().publicKey.toBase58();
}

export const silentLog: Logger = { info: () => {}, warn: () => {}, error: () => {} };

export function makeCtx(over: Omit<Partial<KeeperContext>, 'ledger'> & { ledger: FakeLedger | Ledger }): KeeperContext {
  // Throwaway in-memory keypair; never funded, never sent anywhere (all chain calls are mocked).
  const signer = over.signer === undefined ? Keypair.generate() : over.signer;
  const keeper = over.keeper ?? signer?.publicKey ?? new PublicKey(newAddress());
  const ledger = over.ledger instanceof FakeLedger ? over.ledger.asLedger() : over.ledger;
  return {
    cfg: over.cfg ?? testConfig(),
    conn: over.conn ?? ({} as KeeperContext['conn']),
    keeper,
    signer,
    ledger,
    log: over.log ?? silentLog,
    dryRun: over.dryRun ?? false,
    now: over.now ?? (() => 1_800_000_000),
  };
}

export function coin(mint: string, symbol: string, over: Partial<BasketCoin> = {}): BasketCoin {
  return {
    mint,
    symbol,
    name: symbol,
    image: '',
    pool: newAddress(),
    decimals: 6,
    tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    priceUsd: 0.01,
    marketCapUsd: 1_000_000,
    liquidityUsd: 1_000_000,
    volume24hUsd: 50_000,
    change24h: 0,
    holders: 500,
    ...over,
  };
}

export type { DeliveryItem };
