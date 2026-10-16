import type { Config } from '../../src/config';

/** Full Config for tests; never reads env. Override any field. */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    cluster: 'localnet',
    rpcUrl: 'http://127.0.0.1:8899',
    keeperKeypairPath: null,
    keeperPubkey: null,
    pod5Mint: 'POD5MINT',
    podApiBase: 'http://localhost/api/solana',
    jupiterApiBase: 'http://localhost',
    jupiterApiKey: null,
    dbPath: ':memory:',
    publishDir: './public-test',
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
    ...overrides,
  };
}
