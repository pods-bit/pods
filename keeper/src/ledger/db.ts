// SQLite ledger using Node's built-in `node:sqlite` (DatabaseSync). No native deps.
// Raw amounts are stored as TEXT decimal strings and handled as bigint in code.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  BasketCoin,
  OwedSnapshot,
  RejectedCoin,
  RoundReceipt,
  RoundStatus,
} from '../../../shared/types';

export type BuyState = 'PENDING' | 'SENT' | 'CONFIRMED' | 'FAILED';

export interface BuyRow {
  roundId: number;
  mint: string;
  symbol: string;
  decimals: number;
  tokenProgram: string;
  spentLamports: bigint;
  receivedRaw: bigint;
  state: BuyState;
  signature: string | null;
  lastValidBlockHeight: number | null;
  error: string | null;
}

export interface DeliveryItem {
  wallet: string;
  /** Amount transferred to the wallet. */
  amountRaw: bigint;
  /** Tokens kept back to cover ATA rent the keeper paid; moved to carry on confirm. */
  rentWithheldRaw: bigint;
}

export interface PendingDelivery {
  signature: string;
  roundId: number;
  mint: string;
  lastValidBlockHeight: number;
  items: DeliveryItem[];
}

type Row = Record<string, any>;

const TERMINAL: RoundStatus[] = ['DONE', 'SKIPPED', 'FAILED'];
const UNFINISHED: RoundStatus[] = ['PLANNED', 'BOUGHT', 'CREDITED', 'DELIVERING'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL,
  skipped_reason TEXT,
  pot_lamports TEXT NOT NULL,
  eligible_wallets INTEGER NOT NULL DEFAULT 0,
  basket_json TEXT NOT NULL DEFAULT '[]',
  rejected_json TEXT NOT NULL DEFAULT '[]',
  transfers_sent INTEGER NOT NULL DEFAULT 0,
  delivery_sigs_json TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS buys (
  round_id INTEGER NOT NULL,
  mint TEXT NOT NULL,
  symbol TEXT NOT NULL,
  decimals INTEGER NOT NULL,
  token_program TEXT NOT NULL,
  spent_lamports TEXT NOT NULL,
  received_raw TEXT NOT NULL DEFAULT '0',
  state TEXT NOT NULL,
  signature TEXT,
  last_valid_block_height INTEGER,
  error TEXT,
  PRIMARY KEY (round_id, mint)
);
CREATE TABLE IF NOT EXISTS credit_batches (
  round_id INTEGER NOT NULL,
  mint TEXT NOT NULL,
  new_carry TEXT NOT NULL,
  PRIMARY KEY (round_id, mint)
);
CREATE TABLE IF NOT EXISTS credits (
  round_id INTEGER NOT NULL,
  mint TEXT NOT NULL,
  wallet TEXT NOT NULL,
  amount_raw TEXT NOT NULL,
  PRIMARY KEY (round_id, mint, wallet)
);
CREATE TABLE IF NOT EXISTS owed (
  wallet TEXT NOT NULL,
  mint TEXT NOT NULL,
  amount_raw TEXT NOT NULL,
  PRIMARY KEY (wallet, mint)
);
CREATE TABLE IF NOT EXISTS delivered (
  wallet TEXT NOT NULL,
  mint TEXT NOT NULL,
  amount_raw TEXT NOT NULL,
  PRIMARY KEY (wallet, mint)
);
CREATE TABLE IF NOT EXISTS carry (
  mint TEXT PRIMARY KEY,
  amount_raw TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS deliveries (
  signature TEXT PRIMARY KEY,
  round_id INTEGER NOT NULL,
  mint TEXT NOT NULL,
  last_valid_block_height INTEGER NOT NULL,
  items_json TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS deliveries_status ON deliveries(status);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export class Ledger {
  private db: DatabaseSync;

  /** Opens (creating if needed) the database at `path` (':memory:' allowed) and migrates. */
  constructor(path: string) {
    if (path !== ':memory:' && !path.startsWith('file:')) {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout = 5000');
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = FULL');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ---- internals ----
  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* already rolled back */
      }
      throw e;
    }
  }

  private all(sql: string, ...args: any[]): Row[] {
    return this.db.prepare(sql).all(...args) as Row[];
  }

  private get(sql: string, ...args: any[]): Row | undefined {
    return this.db.prepare(sql).get(...args) as Row | undefined;
  }

  private run(sql: string, ...args: any[]): void {
    this.db.prepare(sql).run(...args);
  }

  private carryOf(mint: string): bigint {
    const r = this.get('SELECT amount_raw FROM carry WHERE mint = ?', mint);
    return r ? BigInt(r.amount_raw) : 0n;
  }

  private setCarry(mint: string, v: bigint): void {
    this.run(
      'INSERT INTO carry (mint, amount_raw) VALUES (?, ?) ON CONFLICT(mint) DO UPDATE SET amount_raw = excluded.amount_raw',
      mint,
      v.toString(),
    );
  }

  private balanceOf(table: 'owed' | 'delivered', wallet: string, mint: string): bigint {
    const r = this.get(`SELECT amount_raw FROM ${table} WHERE wallet = ? AND mint = ?`, wallet, mint);
    return r ? BigInt(r.amount_raw) : 0n;
  }

  private setBalance(table: 'owed' | 'delivered', wallet: string, mint: string, v: bigint): void {
    this.run(
      `INSERT INTO ${table} (wallet, mint, amount_raw) VALUES (?, ?, ?)
       ON CONFLICT(wallet, mint) DO UPDATE SET amount_raw = excluded.amount_raw`,
      wallet,
      mint,
      v.toString(),
    );
  }

  private buyToReceipt(b: Row): RoundReceipt['basket'][number] {
    const out: RoundReceipt['basket'][number] = {
      mint: b.mint,
      symbol: b.symbol,
      decimals: Number(b.decimals),
      spentLamports: b.spent_lamports,
      receivedRaw: b.received_raw,
      signature: b.signature ?? null,
    };
    if (b.error) out.error = b.error;
    return out;
  }

  private rowToReceipt(r: Row): RoundReceipt {
    const buys = this.all('SELECT * FROM buys WHERE round_id = ? ORDER BY rowid', r.id);
    const receipt: RoundReceipt = {
      id: Number(r.id),
      startedAt: Number(r.started_at),
      finishedAt: r.finished_at === null ? null : Number(r.finished_at),
      status: r.status as RoundStatus,
      potLamports: r.pot_lamports,
      eligibleWallets: Number(r.eligible_wallets),
      basket: buys.map((b) => this.buyToReceipt(b)),
      transfersSent: Number(r.transfers_sent),
      deliverySignatures: JSON.parse(r.delivery_sigs_json) as string[],
    };
    if (r.skipped_reason) receipt.skippedReason = r.skipped_reason;
    return receipt;
  }

  // ---- rounds ----
  /**
   * Creates a round. For terminal statuses (SKIPPED/FAILED/DONE) finishedAt = startedAt.
   */
  createRound(r: {
    startedAt: number;
    potLamports: bigint;
    eligibleWallets: number;
    basket: BasketCoin[];
    rejected: RejectedCoin[];
    status?: RoundStatus; // default 'PLANNED'
    skippedReason?: string;
  }): number {
    const status = r.status ?? 'PLANNED';
    const res = this.db
      .prepare(
        `INSERT INTO rounds (started_at, finished_at, status, skipped_reason, pot_lamports,
           eligible_wallets, basket_json, rejected_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.startedAt,
        TERMINAL.includes(status) ? r.startedAt : null,
        status,
        r.skippedReason ?? null,
        r.potLamports.toString(),
        r.eligibleWallets,
        JSON.stringify(r.basket),
        JSON.stringify(r.rejected),
      );
    return Number(res.lastInsertRowid);
  }

  /**
   * Sets status. For a terminal status without extra.finishedAt, finished_at is set to the
   * current wall-clock time (seconds); pass finishedAt for determinism.
   */
  setRoundStatus(
    id: number,
    status: RoundStatus,
    extra?: { skippedReason?: string; finishedAt?: number },
  ): void {
    const finishedAt =
      extra?.finishedAt ?? (TERMINAL.includes(status) ? Math.floor(Date.now() / 1000) : null);
    const res = this.db
      .prepare(
        `UPDATE rounds SET status = ?, skipped_reason = COALESCE(?, skipped_reason),
           finished_at = COALESCE(?, finished_at) WHERE id = ?`,
      )
      .run(status, extra?.skippedReason ?? null, finishedAt, id);
    if (Number(res.changes) === 0) throw new Error(`ledger: no round ${id}`);
  }

  getRound(id: number): RoundReceipt | null {
    const r = this.get('SELECT * FROM rounds WHERE id = ?', id);
    return r ? this.rowToReceipt(r) : null;
  }

  getRoundBasket(id: number): BasketCoin[] {
    const r = this.get('SELECT basket_json FROM rounds WHERE id = ?', id);
    return r ? (JSON.parse(r.basket_json) as BasketCoin[]) : [];
  }

  /** Most recent round in PLANNED | BOUGHT | CREDITED | DELIVERING, or null. */
  getUnfinishedRound(): RoundReceipt | null {
    const ph = UNFINISHED.map(() => '?').join(',');
    const r = this.get(`SELECT * FROM rounds WHERE status IN (${ph}) ORDER BY id DESC LIMIT 1`, ...UNFINISHED);
    return r ? this.rowToReceipt(r) : null;
  }

  /** Newest first. RoundReceipt.basket is built from the buys table. */
  listRounds(limit: number): RoundReceipt[] {
    return this.all('SELECT * FROM rounds ORDER BY id DESC LIMIT ?', Math.max(0, Math.floor(limit))).map((r) =>
      this.rowToReceipt(r),
    );
  }

  // ---- buys ----
  /** Insert or replace the buy row keyed by (roundId, mint). */
  upsertBuy(b: Omit<BuyRow, 'receivedRaw' | 'error'> & { receivedRaw?: bigint; error?: string | null }): void {
    this.run(
      `INSERT INTO buys (round_id, mint, symbol, decimals, token_program, spent_lamports, received_raw,
         state, signature, last_valid_block_height, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(round_id, mint) DO UPDATE SET
         symbol = excluded.symbol, decimals = excluded.decimals, token_program = excluded.token_program,
         spent_lamports = excluded.spent_lamports, received_raw = excluded.received_raw,
         state = excluded.state, signature = excluded.signature,
         last_valid_block_height = excluded.last_valid_block_height, error = excluded.error`,
      b.roundId,
      b.mint,
      b.symbol,
      b.decimals,
      b.tokenProgram,
      b.spentLamports.toString(),
      (b.receivedRaw ?? 0n).toString(),
      b.state,
      b.signature ?? null,
      b.lastValidBlockHeight ?? null,
      b.error ?? null,
    );
  }

  getBuys(roundId: number): BuyRow[] {
    return this.all('SELECT * FROM buys WHERE round_id = ? ORDER BY rowid', roundId).map((r) => ({
      roundId: Number(r.round_id),
      mint: r.mint,
      symbol: r.symbol,
      decimals: Number(r.decimals),
      tokenProgram: r.token_program,
      spentLamports: BigInt(r.spent_lamports),
      receivedRaw: BigInt(r.received_raw),
      state: r.state as BuyState,
      signature: r.signature ?? null,
      lastValidBlockHeight: r.last_valid_block_height === null ? null : Number(r.last_valid_block_height),
      error: r.error ?? null,
    }));
  }

  // ---- carry & credits ----
  getCarry(mint: string): bigint {
    return this.carryOf(mint);
  }

  /** Adds (or, with a negative amount, subtracts) from carry; throws if it would go negative. */
  addCarry(mint: string, amountRaw: bigint): void {
    this.tx(() => {
      const next = this.carryOf(mint) + amountRaw;
      if (next < 0n) throw new Error(`ledger: carry for ${mint} would go negative`);
      this.setCarry(mint, next);
    });
  }

  /**
   * Atomically: record credits for (roundId, mint), add each to owed[wallet][mint], and set
   * carry[mint] = newCarry. Idempotent: a second call for the same (roundId, mint) is a no-op
   * (even with different arguments), tracked by a marker row so empty credit maps count too.
   */
  applyCredits(roundId: number, mint: string, credits: Map<string, bigint>, newCarry: bigint): void {
    if (newCarry < 0n) throw new Error('ledger: newCarry must be >= 0');
    this.tx(() => {
      if (this.get('SELECT 1 AS x FROM credit_batches WHERE round_id = ? AND mint = ?', roundId, mint)) return;
      this.run(
        'INSERT INTO credit_batches (round_id, mint, new_carry) VALUES (?, ?, ?)',
        roundId,
        mint,
        newCarry.toString(),
      );
      for (const [wallet, amount] of credits) {
        if (amount < 0n) throw new Error(`ledger: negative credit for ${wallet}`);
        if (amount === 0n) continue;
        this.run(
          'INSERT INTO credits (round_id, mint, wallet, amount_raw) VALUES (?, ?, ?, ?)',
          roundId,
          mint,
          wallet,
          amount.toString(),
        );
        this.setBalance('owed', wallet, mint, this.balanceOf('owed', wallet, mint) + amount);
      }
      this.setCarry(mint, newCarry);
    });
  }

  hasCredits(roundId: number, mint: string): boolean {
    return !!this.get('SELECT 1 AS x FROM credit_batches WHERE round_id = ? AND mint = ?', roundId, mint);
  }

  /** wallet -> owed raw for this mint (only > 0 entries). */
  getOwedForMint(mint: string): Map<string, bigint> {
    const out = new Map<string, bigint>();
    for (const r of this.all('SELECT wallet, amount_raw FROM owed WHERE mint = ? ORDER BY wallet', mint)) {
      const v = BigInt(r.amount_raw);
      if (v > 0n) out.set(r.wallet, v);
    }
    return out;
  }

  /** Every mint with any owed balance > 0. */
  getOwedMints(): string[] {
    const set = new Set<string>();
    for (const r of this.all('SELECT mint, amount_raw FROM owed ORDER BY mint')) {
      if (BigInt(r.amount_raw) > 0n) set.add(r.mint);
    }
    return [...set];
  }

  // ---- deliveries ----
  /**
   * Record a signed-but-not-yet-confirmed delivery tx BEFORE sending it. Re-recording an
   * existing signature is a no-op (never resets a CONFIRMED/FAILED status).
   */
  recordPendingDelivery(d: PendingDelivery): void {
    this.run(
      `INSERT OR IGNORE INTO deliveries (signature, round_id, mint, last_valid_block_height, items_json, status)
       VALUES (?, ?, ?, ?, ?, 'PENDING')`,
      d.signature,
      d.roundId,
      d.mint,
      d.lastValidBlockHeight,
      JSON.stringify(
        d.items.map((i) => ({
          wallet: i.wallet,
          amountRaw: i.amountRaw.toString(),
          rentWithheldRaw: i.rentWithheldRaw.toString(),
        })),
      ),
    );
  }

  /**
   * Atomically for a confirmed delivery: owed -= amount + rentWithheld per item, delivered +=
   * amount, carry[mint] += sum(rentWithheld), round.transfers_sent += items, add signature to
   * the round's delivery signatures, mark tx confirmed. Idempotent per signature.
   * A FAILED delivery may still be confirmed (the tx landed after we gave up on it).
   * Throws (and rolls everything back, leaving the delivery PENDING) if the signature is
   * unknown or if owed would go negative for any item.
   */
  confirmDelivery(signature: string): void {
    this.tx(() => {
      const d = this.get('SELECT * FROM deliveries WHERE signature = ?', signature);
      if (!d) throw new Error(`ledger: unknown delivery ${signature}`);
      if (d.status === 'CONFIRMED') return;
      const items = JSON.parse(d.items_json) as { wallet: string; amountRaw: string; rentWithheldRaw: string }[];
      let rentTotal = 0n;
      for (const it of items) {
        const amount = BigInt(it.amountRaw);
        const rent = BigInt(it.rentWithheldRaw);
        const owed = this.balanceOf('owed', it.wallet, d.mint);
        const next = owed - amount - rent;
        if (next < 0n) {
          throw new Error(
            `ledger: owed for ${it.wallet}/${d.mint} would go negative (${owed} - ${amount + rent})`,
          );
        }
        this.setBalance('owed', it.wallet, d.mint, next);
        this.setBalance('delivered', it.wallet, d.mint, this.balanceOf('delivered', it.wallet, d.mint) + amount);
        rentTotal += rent;
      }
      if (rentTotal > 0n) this.setCarry(d.mint, this.carryOf(d.mint) + rentTotal);
      const round = this.get('SELECT transfers_sent, delivery_sigs_json FROM rounds WHERE id = ?', d.round_id);
      if (round) {
        const sigs = JSON.parse(round.delivery_sigs_json) as string[];
        if (!sigs.includes(signature)) sigs.push(signature);
        this.run(
          'UPDATE rounds SET transfers_sent = ?, delivery_sigs_json = ? WHERE id = ?',
          Number(round.transfers_sent) + items.length,
          JSON.stringify(sigs),
          d.round_id,
        );
      }
      this.run("UPDATE deliveries SET status = 'CONFIRMED', reason = NULL WHERE signature = ?", signature);
    });
  }

  /** Mark a delivery tx failed/expired; owed is untouched so it retries next round. No-op if already CONFIRMED. */
  failDelivery(signature: string, reason: string): void {
    this.run("UPDATE deliveries SET status = 'FAILED', reason = ? WHERE signature = ? AND status != 'CONFIRMED'", reason, signature);
  }

  getPendingDeliveries(): PendingDelivery[] {
    return this.all("SELECT * FROM deliveries WHERE status = 'PENDING' ORDER BY rowid").map((d) => ({
      signature: d.signature,
      roundId: Number(d.round_id),
      mint: d.mint,
      lastValidBlockHeight: Number(d.last_valid_block_height),
      items: (JSON.parse(d.items_json) as { wallet: string; amountRaw: string; rentWithheldRaw: string }[]).map(
        (i) => ({
          wallet: i.wallet,
          amountRaw: BigInt(i.amountRaw),
          rentWithheldRaw: BigInt(i.rentWithheldRaw),
        }),
      ),
    }));
  }

  // ---- reporting ----
  /** spentLamports = sum of spent_lamports over CONFIRMED buys. */
  totals(): { rounds: number; roundsRun: number; spentLamports: bigint; transfersSent: number; walletsPaid: number } {
    const rounds = this.get(
      "SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN status = 'DONE' THEN 1 ELSE 0 END), 0) AS run, COALESCE(SUM(transfers_sent), 0) AS t FROM rounds",
    )!;
    let spent = 0n;
    for (const r of this.all("SELECT spent_lamports FROM buys WHERE state = 'CONFIRMED'")) {
      spent += BigInt(r.spent_lamports);
    }
    const wallets = new Set<string>();
    for (const r of this.all('SELECT wallet, amount_raw FROM delivered')) {
      if (BigInt(r.amount_raw) > 0n) wallets.add(r.wallet);
    }
    return {
      rounds: Number(rounds.n),
      roundsRun: Number(rounds.run),
      spentLamports: spent,
      transfersSent: Number(rounds.t),
      walletsPaid: wallets.size,
    };
  }

  owedSnapshot(nowSec: number): OwedSnapshot {
    const build = (table: 'owed' | 'delivered'): Record<string, Record<string, string>> => {
      const out: Record<string, Record<string, string>> = {};
      for (const r of this.all(`SELECT wallet, mint, amount_raw FROM ${table} ORDER BY wallet, mint`)) {
        if (BigInt(r.amount_raw) <= 0n) continue;
        (out[r.wallet] ??= {})[r.mint] = r.amount_raw;
      }
      return out;
    };
    return { updatedAt: nowSec, owed: build('owed'), delivered: build('delivered') };
  }

  // ---- key/value (last published basket preview, etc.) ----
  getMeta(key: string): string | null {
    const r = this.get('SELECT value FROM meta WHERE key = ?', key);
    return r ? r.value : null;
  }

  setMeta(key: string, value: string): void {
    this.run(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key,
      value,
    );
  }
}
