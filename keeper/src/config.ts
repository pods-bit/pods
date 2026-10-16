// All tunables live here. Every value can be overridden with an env var of the same name.

export interface Config {
  cluster: 'mainnet-beta' | 'devnet' | 'localnet';
  rpcUrl: string;
  /** Path to a Solana keypair JSON file (array of 64 numbers). Optional in dry-run. */
  keeperKeypairPath: string | null;
  /** Public key of the keeper; used when no keypair is loaded (dry-run). */
  keeperPubkey: string | null;
  pod5Mint: string | null;
  podApiBase: string;
  jupiterApiBase: string;
  jupiterApiKey: string | null;
  dbPath: string;
  publishDir: string;

  /** Extra wallets never paid (POD5 pool, deployer, Pod platform/treasury). */
  excludeWallets: string[];
  /** Mints never selected for the basket (besides POD5 itself). */
  excludeMints: string[];

  roundIntervalMin: number;
  minPotLamports: bigint;
  opReserveLamports: bigint;
  /** Hard cap on lamports spent per round (canary). null = no cap. */
  potCapLamports: bigint | null;

  minHoldUsd: number;
  maxCoins: number;
  minLiqUsd: number;
  maxSliceOfLiq: number;
  maxImpactBps: number;
  slippageBps: number;
  minHolders: number;
  minVol24hUsd: number;
  minTrades24h: number;
  minAgeHours: number;
  /** Share must be worth rentMargin × ATA rent before we open an account for it. */
  rentMargin: number;
  /** Max transfer instructions per delivery transaction (without ATA creation). */
  transfersPerTx: number;
  /** Max ATA-create+transfer pairs per delivery transaction. */
  ataCreatesPerTx: number;
  priorityFeeMicroLamports: number;
  alertWebhookUrl: string | null;
}

const LAMPORTS_PER_SOL = 1_000_000_000;

function num(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`config: ${name} must be a number, got "${v}"`);
  return n;
}

function str(name: string, def: string | null): string | null {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
}

function sol(name: string, def: number | null): bigint | null {
  const v = process.env[name];
  const n = v === undefined || v === '' ? def : Number(v);
  if (n === null) return null;
  if (!Number.isFinite(n) || n < 0) throw new Error(`config: ${name} must be a non-negative SOL amount`);
  return BigInt(Math.round(n * LAMPORTS_PER_SOL));
}

function list(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(): Config {
  const cluster = (str('CLUSTER', 'mainnet-beta') as Config['cluster']);
  return {
    cluster,
    rpcUrl: str('RPC_URL', 'https://api.mainnet-beta.solana.com')!,
    keeperKeypairPath: str('KEEPER_KEYPAIR', null),
    keeperPubkey: str('KEEPER_PUBKEY', null),
    pod5Mint: str('POD5_MINT', null),
    podApiBase: str('POD_API_BASE', 'https://orcapod.fun/api/solana')!,
    jupiterApiBase: str('JUPITER_API_BASE', 'https://lite-api.jup.ag')!,
    jupiterApiKey: str('JUPITER_API_KEY', null),
    dbPath: str('DB_PATH', './data/keeper.db')!,
    publishDir: str('PUBLISH_DIR', './public')!,

    excludeWallets: list('EXCLUDE_WALLETS'),
    excludeMints: list('EXCLUDE_MINTS'),

    roundIntervalMin: num('ROUND_INTERVAL_MIN', 15),
    minPotLamports: sol('MIN_POT_SOL', 0.05)!,
    opReserveLamports: sol('OP_RESERVE_SOL', 0.05)!,
    potCapLamports: sol('POT_CAP_SOL', null),

    minHoldUsd: num('MIN_HOLD_USD', 30),
    maxCoins: num('MAX_COINS', 5),
    minLiqUsd: num('MIN_LIQ_USD', 5000),
    maxSliceOfLiq: num('MAX_SLICE_OF_LIQ', 0.01),
    maxImpactBps: num('MAX_IMPACT_BPS', 300),
    slippageBps: num('SLIPPAGE_BPS', 300),
    minHolders: num('MIN_HOLDERS', 50),
    minVol24hUsd: num('MIN_VOL24H_USD', 1000),
    minTrades24h: num('MIN_TRADES24H', 20),
    minAgeHours: num('MIN_AGE_H', 24),
    rentMargin: num('RENT_MARGIN', 1.5),
    transfersPerTx: num('TRANSFERS_PER_TX', 18),
    ataCreatesPerTx: num('ATA_CREATES_PER_TX', 8),
    priorityFeeMicroLamports: num('PRIORITY_FEE_MICROLAMPORTS', 50_000),
    alertWebhookUrl: str('ALERT_WEBHOOK_URL', null),
  };
}

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const LAMPORTS = BigInt(LAMPORTS_PER_SOL);
