import { describe, expect, it } from 'vitest';
import { ExtensionType } from '@solana/spl-token';
import { Keypair } from '@solana/web3.js';
import { absoluteImageUrl, normaliseMarket } from '../src/sources/pod';
import { priceImpactToBps } from '../src/sources/jupiter';
import { mintRejection } from '../src/chain/mintCheck';
import { parseSlice } from '../src/chain/holders';

const MINT = 'F4K2SbLNgyz9gzNqT8bPeLpRkxy4oMA9twaffUDdZtB6';
const POOL = '4759SGgn3ypWtPHoBq65wCWa1t1tbdA5cwsKjoHuX39d';
const WSOL = 'So11111111111111111111111111111111111111112';

const row = {
  mint: MINT,
  pool: POOL,
  symbol: 'POD',
  name: 'orcapod.fun',
  image: '/img/abc',
  quoteMint: WSOL,
  quoteTicker: 'SOL',
  quoteUsd: 100,
  priceUsd: 8.6e-5,
  marketCapUsd: 86000,
  quoteReserve: 134.5,
  volume24hUsd: 9098,
  trades24h: 227,
  holders: 1390,
  change24h: -20.5,
  createdAt: 1790527520,
  suspect: false,
  paused: false,
  extra: { ignored: true },
};

describe('pod normalisation', () => {
  it('normalises a good row and derives liquidity', () => {
    const m = normaliseMarket(row)!;
    expect(m).not.toBeNull();
    expect(m.liquidityUsd).toBeCloseTo(13450, 6);
    expect(m.image).toBe('https://orcapod.fun/img/abc');
    expect(m.mint).toBe(MINT);
    expect('extra' in m).toBe(false);
  });
  it('skips malformed rows', () => {
    expect(normaliseMarket({ ...row, mint: undefined })).toBeNull();
    expect(normaliseMarket({ ...row, marketCapUsd: 'x' })).toBeNull();
    expect(normaliseMarket({ ...row, quoteReserve: Number.NaN })).toBeNull();
    expect(normaliseMarket(null)).toBeNull();
    expect(normaliseMarket('nope')).toBeNull();
  });
  it('defaults optional numeric/boolean fields', () => {
    const m = normaliseMarket({ ...row, holders: null, suspect: undefined, paused: null, image: null })!;
    expect(m.holders).toBe(0);
    expect(m.suspect).toBe(false);
    expect(m.paused).toBe(false);
    expect(m.image).toBe('');
  });
  it('keeps absolute image urls', () => {
    expect(absoluteImageUrl('https://x.test/a.png')).toBe('https://x.test/a.png');
    expect(absoluteImageUrl('img/a')).toBe('https://orcapod.fun/img/a');
  });
});

describe('jupiter price impact', () => {
  it('converts fraction strings to bps', () => {
    expect(priceImpactToBps('0.0123')).toBeCloseTo(123, 6);
    expect(priceImpactToBps('0')).toBe(0);
    expect(priceImpactToBps('0.0464645757509074')).toBeCloseTo(464.6, 1);
  });
  it('treats junk as unsafe', () => {
    expect(priceImpactToBps(undefined)).toBe(Infinity);
    expect(priceImpactToBps('abc')).toBe(Infinity);
    expect(priceImpactToBps('-1')).toBe(Infinity);
  });
});

describe('mint rejection', () => {
  const clean = { mintAuthority: null, freezeAuthority: null, extensions: [] as ExtensionType[], defaultStateFrozen: false };
  it('accepts a clean mint and benign extensions', () => {
    expect(mintRejection(clean)).toBeUndefined();
    expect(mintRejection({ ...clean, extensions: [ExtensionType.MetadataPointer, ExtensionType.TokenMetadata] })).toBeUndefined();
  });
  it('rejects authorities', () => {
    expect(mintRejection({ ...clean, freezeAuthority: 'x' })).toMatch(/freeze/);
    expect(mintRejection({ ...clean, mintAuthority: 'x' })).toMatch(/mint authority/);
  });
  it('rejects dangerous extensions', () => {
    for (const e of [
      ExtensionType.TransferFeeConfig,
      ExtensionType.PermanentDelegate,
      ExtensionType.TransferHook,
      ExtensionType.NonTransferable,
      ExtensionType.ConfidentialTransferMint,
      ExtensionType.PausableConfig,
    ]) {
      expect(mintRejection({ ...clean, extensions: [e] }), String(e)).toBeTruthy();
    }
    expect(mintRejection({ ...clean, defaultStateFrozen: true })).toMatch(/DefaultAccountState/);
  });
});

describe('holder slice parsing', () => {
  it('parses owner and u64 LE amount', () => {
    const owner = Keypair.generate().publicKey.toBytes();
    const buf = new Uint8Array(40);
    buf.set(owner, 0);
    new DataView(buf.buffer).setBigUint64(32, 123456789012345n, true);
    const p = parseSlice(buf)!;
    expect(Buffer.from(p.owner).equals(Buffer.from(owner))).toBe(true);
    expect(p.amount).toBe(123456789012345n);
  });
  it('rejects short data', () => {
    expect(parseSlice(new Uint8Array(39))).toBeNull();
  });
});

import { measuredImpactBps } from '../src/sources/jupiter';
describe('measuredImpactBps', () => {
  it('is 0 when our rate matches the reference rate', () => {
    expect(measuredImpactBps(1000n, 5000n, 20n, 100n)).toBe(0);
  });
  it('measures a 2% worse rate as 200 bps', () => {
    expect(measuredImpactBps(1000n, 4900n, 20n, 100n)).toBe(200);
  });
  it('never goes negative when our rate is better', () => {
    expect(measuredImpactBps(1000n, 5100n, 20n, 100n)).toBe(0);
  });
  it('treats a missing reference as unsafe', () => {
    expect(measuredImpactBps(1000n, 5000n, 20n, 0n)).toBe(Number.POSITIVE_INFINITY);
  });
});
