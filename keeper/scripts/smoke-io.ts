// Read-only live smoke test of the I/O layer. Never signs or sends anything.
import { PublicKey } from '@solana/web3.js';
import { loadConfig, WSOL_MINT, LAMPORTS } from '../src/config';
import { fetchMarkets } from '../src/sources/pod';
import { getPricesUsd, getQuote } from '../src/sources/jupiter';
import { createConnection, getAtaRentLamports } from '../src/chain/rpc';
import { checkMint } from '../src/chain/mintCheck';
import { getOwnersWithAta, snapshotHolders } from '../src/chain/holders';

async function main() {
  const cfg = loadConfig();
  const conn = createConnection(cfg);
  console.log(`rpc=${cfg.rpcUrl} jupiter=${cfg.jupiterApiBase} pod=${cfg.podApiBase}`);

  const markets = await fetchMarkets(cfg);
  const top = [...markets].sort((a, b) => b.marketCapUsd - a.marketCapUsd);
  console.log(`\n[pod] ${markets.length} markets; top 5 by mcap:`);
  for (const m of top.slice(0, 5)) {
    console.log(
      `  ${m.symbol.padEnd(8)} mcap=$${m.marketCapUsd.toFixed(0)} liq=$${m.liquidityUsd.toFixed(0)} holders=${m.holders} ${m.mint}`,
    );
  }

  console.log('\n[mintCheck] top 3:');
  for (const m of top.slice(0, 3)) {
    const c = await checkMint(conn, m.mint);
    console.log(`  ${m.symbol.padEnd(8)} ok=${c.ok} decimals=${c.decimals} program=${c.tokenProgram} reason=${c.reason ?? '-'}`);
  }

  const first = top[0]!;
  const q = await getQuote(cfg, {
    inputMint: WSOL_MINT,
    outputMint: first.mint,
    amount: LAMPORTS / 10n,
    slippageBps: cfg.slippageBps,
  });
  console.log(
    `\n[jupiter] quote 0.1 SOL -> ${first.symbol}: ` +
      (q ? `outAmount=${q.outAmount} impactBps=${q.priceImpactBps.toFixed(2)}` : 'no route'),
  );

  const prices = await getPricesUsd(cfg, [WSOL_MINT, ...top.slice(0, 3).map((m) => m.mint)]);
  console.log('[jupiter] prices:', prices);

  try {
    const rent = await getAtaRentLamports(conn, new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA').toBase58());
    console.log(`\n[rpc] ATA rent (classic) = ${rent} lamports`);
  } catch (e) {
    console.log('[rpc] ATA rent failed:', (e as Error).message);
  }

  const small = markets
    .filter((m) => m.holders >= 20 && m.holders <= 250 && !m.paused)
    .sort((a, b) => b.holders - a.holders)[0];
  if (!small) {
    console.log('\n[holders] no small coin found');
    return;
  }
  console.log(`\n[holders] snapshot ${small.symbol} (${small.mint}), Pod says ${small.holders} holders`);
  try {
    const c = await checkMint(conn, small.mint);
    const holders = await snapshotHolders(conn, small.mint, c.tokenProgram, new Set());
    console.log(`  snapshotHolders -> ${holders.length} on-curve holders; top 3:`);
    for (const h of holders.slice(0, 3)) console.log(`    ${h.owner} ${h.amountRaw}`);
    const sample = holders.slice(0, 5).map((h) => h.owner);
    const withAta = await getOwnersWithAta(conn, small.mint, c.tokenProgram, sample);
    console.log(`  getOwnersWithAta: ${withAta.size}/${sample.length} of sampled top holders have their ATA`);
  } catch (e) {
    console.log(`  HOLDERS CALL FAILED: ${(e as Error).message}`);
    console.log('  (public RPCs commonly reject getProgramAccounts; a paid RPC is required in production)');
  }
}

main().catch((e) => {
  console.error('smoke failed:', e);
  process.exit(1);
});
