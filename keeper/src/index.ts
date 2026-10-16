// CLI entry.
//   tsx src/index.ts round [--dry-run] [--pot <SOL>] [--holders-of <mint>]
//   tsx src/index.ts daemon            run a round every cfg.roundIntervalMin minutes
//   tsx src/index.ts publish           rewrite public JSON from the ledger
// Loads .env (process.loadEnvFile) when present. Daemon: never overlaps rounds, catches and
// alerts on errors, exits cleanly on SIGINT/SIGTERM after the current round, kill switch:
// if file `${dirname(dbPath)}/STOP` exists, skip rounds.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { LAMPORTS, loadConfig, type Config } from './config';
import type { KeeperContext } from './context';
import { Ledger } from './ledger/db';
import { alert, createLogger, type Logger } from './log';
import { createConnection, getSolBalance, loadKeeper } from './chain/rpc';
import { runRound, type RoundOptions } from './round/runner';
import { publishState } from './publish';

const USAGE = `usage:
  tsx src/index.ts round [--dry-run] [--pot <SOL>] [--holders-of <mint>]
  tsx src/index.ts daemon
  tsx src/index.ts publish`;

const NO_INFLOW_ALERT_SEC = 6 * 3600;
const META_INFLOW_LAST_BALANCE = 'inflow_last_balance';
const META_INFLOW_LAST_INCREASE_AT = 'inflow_last_increase_at';
const META_INFLOW_ALERTED_AT = 'inflow_alerted_at';

const nowSec = () => Math.floor(Date.now() / 1000);

function loadEnv(): void {
  for (const p of ['.env', join(dirname(new URL(import.meta.url).pathname), '..', '.env')]) {
    if (existsSync(p)) {
      process.loadEnvFile(p);
      return;
    }
  }
}

function parseSol(v: string | undefined, flag: string): bigint {
  const n = Number(v);
  if (v === undefined || v === '' || !Number.isFinite(n) || n < 0) throw new Error(`${flag} needs a non-negative SOL amount`);
  return BigInt(Math.round(n * Number(LAMPORTS)));
}

function parseRoundArgs(args: string[]): { dryRun: boolean; opts: RoundOptions } {
  const opts: RoundOptions = {};
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dry-run') dryRun = true;
    else if (a === '--pot') opts.potOverrideLamports = parseSol(args[++i], '--pot');
    else if (a === '--holders-of') {
      const m = args[++i];
      if (!m) throw new Error('--holders-of needs a mint address');
      opts.holdersMintOverride = m;
    } else throw new Error(`unknown flag ${a}\n${USAGE}`);
  }
  if (!dryRun && (opts.potOverrideLamports !== undefined || opts.holdersMintOverride)) {
    throw new Error('--pot and --holders-of are only allowed together with --dry-run');
  }
  return { dryRun, opts };
}

function makeContext(cfg: Config, log: Logger, opts: { dryRun: boolean; requireSigner: boolean }): KeeperContext {
  const conn = createConnection(cfg);
  const { pubkey, signer } = loadKeeper(cfg);
  if (opts.requireSigner && !signer) {
    throw new Error('a live run needs the keeper keypair: set KEEPER_KEYPAIR to the keypair JSON file');
  }
  let ledger: Ledger;
  if (opts.dryRun) {
    ledger = new Ledger(':memory:');
  } else {
    mkdirSync(dirname(cfg.dbPath), { recursive: true });
    ledger = new Ledger(cfg.dbPath);
  }
  return { cfg, conn, keeper: pubkey, signer, ledger, log, dryRun: opts.dryRun, now: nowSec };
}

/** Exclusive process lock next to the DB so a CLI round and the daemon never overlap. */
function acquireLock(cfg: Config): () => void {
  const path = join(dirname(cfg.dbPath), 'keeper.lock');
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, String(process.pid), { flag: 'wx' });
      return () => {
        try {
          if (readFileSync(path, 'utf8') === String(process.pid)) rmSync(path);
        } catch {
          /* already gone */
        }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const pid = Number(readFileSync(path, 'utf8'));
      let alive = false;
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          alive = true;
        } catch (err) {
          alive = (err as NodeJS.ErrnoException).code === 'EPERM';
        }
      }
      if (alive) throw new Error(`another keeper process (pid ${pid}) holds ${path}`);
      rmSync(path, { force: true }); // stale lock
    }
  }
  throw new Error(`could not acquire ${path}`);
}

function stopFile(cfg: Config): string {
  return join(dirname(cfg.dbPath), 'STOP');
}

/** Alert when the keeper balance has not increased (no Harbor payout) for NO_INFLOW_ALERT_SEC. */
async function checkInflow(ctx: KeeperContext, balance: bigint): Promise<void> {
  const { ledger, cfg, log } = ctx;
  const now = ctx.now();
  const last = ledger.getMeta(META_INFLOW_LAST_BALANCE);
  const lastIncrease = Number(ledger.getMeta(META_INFLOW_LAST_INCREASE_AT) ?? '') || 0;
  if (last === null || last === '' || lastIncrease === 0 || balance > BigInt(last)) {
    ledger.setMeta(META_INFLOW_LAST_INCREASE_AT, String(now));
    return;
  }
  if (now - lastIncrease >= NO_INFLOW_ALERT_SEC) {
    const alertedAt = Number(ledger.getMeta(META_INFLOW_ALERTED_AT) ?? '') || 0;
    if (alertedAt < lastIncrease || now - alertedAt >= NO_INFLOW_ALERT_SEC) {
      const h = ((now - lastIncrease) / 3600).toFixed(1);
      log.warn('no SOL inflow', { hours: h });
      await alert(cfg, `no SOL inflow to the keeper wallet for ${h}h — check Harbor payouts`);
      ledger.setMeta(META_INFLOW_ALERTED_AT, String(now));
    }
  }
}

async function cmdRound(cfg: Config, log: Logger, args: string[]): Promise<void> {
  const { dryRun, opts } = parseRoundArgs(args);
  const ctx = makeContext(cfg, log, { dryRun, requireSigner: !dryRun });
  const release = dryRun ? () => {} : acquireLock(cfg);
  try {
    if (!dryRun && existsSync(stopFile(cfg))) {
      log.warn(`kill switch ${stopFile(cfg)} present; not running`);
      return;
    }
    const r = await runRound(ctx, opts);
    log.info('round result', {
      id: r.id,
      status: r.status,
      skippedReason: r.skippedReason,
      pot: r.potLamports,
      eligible: r.eligibleWallets,
      transfersSent: r.transfersSent,
    });
  } finally {
    release();
    ctx.ledger.close();
  }
}

async function cmdDaemon(cfg: Config, log: Logger): Promise<void> {
  const ctx = makeContext(cfg, log, { dryRun: false, requireSigner: true });
  const release = acquireLock(cfg);
  const intervalMs = Math.max(1, cfg.roundIntervalMin) * 60_000;
  let stopping = false;
  let wake: (() => void) | null = null;
  const onSignal = (sig: string) => {
    if (stopping) {
      log.warn(`${sig} again; exiting now`);
      release();
      process.exit(1);
    }
    stopping = true;
    log.info(`${sig} received; stopping after the current round`);
    wake?.();
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  const sleepUntilNextSlot = () =>
    new Promise<void>((resolve) => {
      const next = Math.floor(Date.now() / intervalMs + 1) * intervalMs;
      log.info('next round', { at: new Date(next).toISOString() });
      const t = setTimeout(() => {
        wake = null;
        resolve();
      }, next - Date.now());
      wake = () => {
        clearTimeout(t);
        wake = null;
        resolve();
      };
    });

  log.info('daemon started', { keeper: ctx.keeper.toBase58(), intervalMin: cfg.roundIntervalMin, cluster: cfg.cluster });
  try {
    while (!stopping) {
      await sleepUntilNextSlot();
      if (stopping) break;
      if (existsSync(stopFile(cfg))) {
        log.warn(`kill switch ${stopFile(cfg)} present; skipping round`);
        continue;
      }
      try {
        // Inflow is measured BEFORE the round (vs the balance left after the previous one).
        await checkInflow(ctx, await getSolBalance(ctx.conn, ctx.keeper));
      } catch (e) {
        log.warn('inflow check failed', { error: e instanceof Error ? e.message : String(e) });
      }
      try {
        const r = await runRound(ctx); // alerts on its own errors
        log.info('round result', { id: r.id, status: r.status, skippedReason: r.skippedReason, transfersSent: r.transfersSent });
      } catch (e) {
        log.error('round threw', { error: e instanceof Error ? e.message : String(e) });
      }
      try {
        ctx.ledger.setMeta(META_INFLOW_LAST_BALANCE, (await getSolBalance(ctx.conn, ctx.keeper)).toString());
      } catch (e) {
        log.warn('post-round balance read failed', { error: e instanceof Error ? e.message : String(e) });
      }
    }
  } finally {
    log.info('daemon stopped');
    ctx.ledger.close();
    release();
  }
}

async function cmdPublish(cfg: Config, log: Logger): Promise<void> {
  const ctx = makeContext(cfg, log, { dryRun: false, requireSigner: false });
  try {
    await publishState(ctx);
    log.info('published', { dir: cfg.publishDir });
  } finally {
    ctx.ledger.close();
  }
}

async function main(): Promise<void> {
  loadEnv();
  const cfg = loadConfig();
  const log = createLogger();
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'round':
      return cmdRound(cfg, log, rest);
    case 'daemon':
      if (rest.length) throw new Error(`daemon takes no flags\n${USAGE}`);
      return cmdDaemon(cfg, log);
    case 'publish':
      return cmdPublish(cfg, log);
    default:
      console.error(USAGE);
      process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
