import './styles.css';
import type { BasketCoin, OwedSnapshot, PublicState, RoundReceipt } from '../../shared/types';
import { POLL_MS, tradeUrl, POD_ORIGIN } from './config';
import { getBalanceLamports, getSolUsd, loadOwed, loadState } from './data';
import { $, clear, externalLink, h, safeImage, setText } from './dom';
import {
  DASH,
  fmtDateTime,
  fmtInt,
  fmtPct,
  fmtSol,
  fmtUsd,
  fmtUsdCompact,
  isSignature,
  lamportsToSol,
  shortAddr,
  solscanAccount,
  solscanTx,
  timeAgo,
} from './format';
import { initThemeToggle } from './theme';
import { initWalletChecker } from './wallet';

interface Model {
  state: PublicState | null;
  statePreview: boolean;
  owed: OwedSnapshot | null;
  owedPreview: boolean;
  keeperLamports: number | null;
  solUsd: number | null;
  /** The balance request failed and we have nothing older to show. */
  balanceFailed: boolean;
}

const model: Model = {
  state: null,
  statePreview: false,
  owed: null,
  owedPreview: false,
  keeperLamports: null,
  solUsd: null,
  balanceFailed: false,
};

// ---------- polling ----------

async function poll(): Promise<void> {
  const [st, ow] = await Promise.allSettled([loadState(), loadOwed()]);
  if (st.status === 'fulfilled') {
    // Never replace data we already have from the live file with the bundled sample.
    if (!st.value.preview || !model.state || model.statePreview) {
      model.state = st.value.data;
      model.statePreview = st.value.preview;
    }
  }
  if (ow.status === 'fulfilled') {
    if (!ow.value.preview || !model.owed || model.owedPreview) {
      model.owed = ow.value.data;
      model.owedPreview = ow.value.preview;
    }
  }

  const keeper = model.state?.keeperWallet;
  const [bal, px] = await Promise.allSettled([keeper ? getBalanceLamports(keeper) : Promise.reject(new Error('no keeper')), getSolUsd()]);
  if (bal.status === 'fulfilled') {
    model.keeperLamports = bal.value;
    model.balanceFailed = false;
  } else if (model.state?.keeperLamports) {
    // Browser can't reach the RPC (public RPC blocks browsers): use the keeper's published balance.
    model.keeperLamports = Number(model.state.keeperLamports);
    model.balanceFailed = false;
  } else if (!keeper) {
    model.keeperLamports = null;
    model.balanceFailed = false;
  } else {
    model.balanceFailed = model.keeperLamports === null;
  }
  if (px.status === 'fulfilled' && px.value !== null) model.solUsd = px.value;
  else if (model.solUsd === null && typeof model.state?.solUsd === 'number') model.solUsd = model.state.solUsd;

  render();
}

// ---------- rendering ----------

const renderKeys = new Map<string, string>();
/** Re-render a section only when its input actually changed. */
function once(name: string, key: unknown, fn: () => void): void {
  const k = JSON.stringify(key);
  if (renderKeys.get(name) === k) return;
  renderKeys.set(name, k);
  fn();
}

function setHidden(id: string, hidden: boolean): void {
  const el = document.getElementById(id);
  if (el) el.hidden = hidden;
}

function lastPayout(rounds: RoundReceipt[]): RoundReceipt | undefined {
  return rounds.find((r) => r.status === 'DONE') ?? rounds.find((r) => r.transfersSent > 0);
}

function render(): void {
  const s = model.state;
  const preview = model.statePreview;

  // links that depend on the published mint / keeper wallet
  const href = tradeUrl(s?.pod5Mint);
  for (const id of ['tradeBtn', 'heroTrade']) {
    const a = document.getElementById(id) as HTMLAnchorElement | null;
    if (a && a.href !== href) a.href = href;
  }
  const fk = document.getElementById('footKeeper') as HTMLAnchorElement | null;
  if (fk) {
    if (s?.keeperWallet) {
      fk.href = solscanAccount(s.keeperWallet);
      fk.hidden = false;
    } else fk.hidden = true;
  }

  if (s) {
    setText('heroCoins', `Up to ${s.maxCoins}`);
    setText('heroHold', `$${s.minHoldUsd}`);
  }
  for (const id of ['previewStats', 'previewBasket', 'previewRounds']) setHidden(id, !preview);

  renderStats(s, preview);
  renderBasket(s);
  renderRounds(s);

  const sample = document.getElementById('walletSample');
  if (sample) sample.hidden = !(model.owedPreview && model.owed && Object.keys(model.owed.delivered).length > 0);
}

function renderStats(s: PublicState | null, preview: boolean): void {
  // Fees waiting
  if (model.keeperLamports !== null) {
    const sol = lamportsToSol(model.keeperLamports);
    setText('statFees', fmtSol(sol, 3));
    setText('statFeesSub', model.solUsd !== null ? `≈ ${fmtUsd(sol * model.solUsd)} in the keeper wallet` : 'SOL in the keeper wallet');
  } else {
    setText('statFees', DASH);
    setText(
      'statFeesSub',
      !s ? 'Waiting for data' : !s.keeperWallet ? (preview ? 'Not connected in preview' : 'Keeper wallet not published yet') : model.balanceFailed ? 'Could not reach the RPC node' : 'Connecting…',
    );
  }

  // Last payout
  const lp = s ? lastPayout(s.rounds) : undefined;
  if (lp) {
    const t = lp.finishedAt ?? lp.startedAt;
    setText('statLast', timeAgo(t));
    setText('statLastSub', `Round #${lp.id} · ${fmtDateTime(t)}`);
  } else {
    setText('statLast', DASH);
    setText('statLastSub', s ? 'No payout yet' : ' ');
  }

  // Basket sums
  if (s && s.basket.length > 0) {
    setText('statMcap', fmtUsdCompact(s.basket.reduce((a, c) => a + (c.marketCapUsd || 0), 0)));
    setText('statVol', fmtUsdCompact(s.basket.reduce((a, c) => a + (c.volume24hUsd || 0), 0)));
  } else {
    setText('statMcap', DASH);
    setText('statVol', DASH);
  }
}

function coinCell(c: BasketCoin): HTMLElement {
  const src = safeImage(c.image);
  const logo = src
    ? h('img', { class: 'logo', src, width: '32', height: '32', alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' })
    : h('span', { class: 'logo logo-fallback', 'aria-hidden': 'true' }, (c.symbol || '?').slice(0, 1));
  if (logo instanceof HTMLImageElement) {
    logo.addEventListener('error', () => logo.replaceWith(h('span', { class: 'logo logo-fallback', 'aria-hidden': 'true' }, (c.symbol || '?').slice(0, 1))), { once: true });
  }
  const name = externalLink(`${POD_ORIGIN}/t/${encodeURIComponent(c.mint)}`, c.symbol, 'coin-link');
  name.setAttribute('aria-label', `${c.symbol} on Pod (opens in a new tab)`);
  return h('div', { class: 'coin' }, logo, h('div', {}, h('b', {}, name), h('span', { class: 'sub' }, c.name)));
}

function renderBasket(s: PublicState | null): void {
  const body = $('basketBody');
  once('basket', s && [s.basket, s.maxCoins, s.updatedAt], () => {
    clear(body);
    if (!s) {
      body.append(h('tr', {}, h('td', { colspan: '7', class: 'empty' }, 'The keeper has not published any data yet.')));
      return;
    }
    if (s.basket.length === 0) {
      body.append(h('tr', {}, h('td', { colspan: '7', class: 'empty' }, 'No Pod coin passes every filter right now. Rounds skip and the pot carries over until one does.')));
    }
    const slice = s.basket.length > 0 ? 100 / s.basket.length : 0;
    s.basket.forEach((c, i) => {
      const chg = c.change24h;
      body.append(
        h(
          'tr',
          {},
          h('td', { class: 'rank' }, String(i + 1)),
          h('td', {}, coinCell(c)),
          h('td', { class: 'num' }, fmtUsdCompact(c.marketCapUsd)),
          h('td', { class: `num ${chg > 0 ? 'up' : chg < 0 ? 'down' : ''}` }, fmtPct(chg)),
          h('td', { class: 'num' }, fmtUsdCompact(c.volume24hUsd)),
          h('td', { class: 'num' }, fmtInt(c.holders)),
          h('td', { class: 'num' }, `${Number.isInteger(slice) ? slice : slice.toFixed(1)}%`),
        ),
      );
    });

    const list = $('whyList');
    clear(list);
    for (const r of s.rejected) {
      list.append(h('li', {}, h('b', {}, r.symbol || shortAddr(r.mint)), h('span', { class: 'mint' }, shortAddr(r.mint)), h('span', { class: 'reason' }, r.reason)));
    }
    if (s.rejected.length === 0) list.append(h('li', {}, h('span', { class: 'reason' }, 'Nothing was passed over in the last check.')));
    setText('whyCount', s.rejected.length > 0 ? `(${s.rejected.length} passed over)` : '');
  });
  // The "updated" line changes with time, so it is outside the cache.
  if (s) {
    setText('basketMeta', `${s.basket.length} of ${s.maxCoins} slots filled · line-up checked ${timeAgo(s.updatedAt)}`);
  } else {
    setText('basketMeta', '');
  }
}

const STATUS_LABEL: Record<RoundReceipt['status'], string> = {
  PLANNED: 'Planned',
  BOUGHT: 'Bought',
  CREDITED: 'Credited',
  DELIVERING: 'Delivering',
  DONE: 'Done',
  SKIPPED: 'Skipped',
  FAILED: 'Failed',
};

function renderRounds(s: PublicState | null): void {
  const host = $('roundsList');
  once('rounds', s && s.rounds.slice(0, 12), () => {
    clear(host);
    if (!s) {
      host.append(h('p', { class: 'muted' }, 'The keeper has not published any data yet.'));
      return;
    }
    if (s.rounds.length === 0) {
      host.append(h('p', { class: 'muted' }, 'No rounds yet. The first one runs once POD5 is live and the pot is big enough to be worth spending.'));
      return;
    }
    const rows = s.rounds.slice(0, 12).map((r) => {
      const bought = r.basket.filter((b) => !b.error && b.spentLamports !== '0');
      const spent = bought.reduce((a, b) => a + (Number.isFinite(lamportsToSol(b.spentLamports)) ? lamportsToSol(b.spentLamports) : 0), 0);
      const coins = bought.length > 0 ? bought.map((b) => b.symbol).join(', ') : r.skippedReason ?? DASH;

      const links: HTMLElement[] = [];
      for (const b of bought) if (isSignature(b.signature)) links.push(externalLink(solscanTx(b.signature), `Buy ${b.symbol}`));
      const dsigs = r.deliverySignatures.filter(isSignature);
      dsigs.slice(0, 3).forEach((sig, i) => links.push(externalLink(solscanTx(sig), `Send ${i + 1}`)));
      if (dsigs.length > 3) links.push(h('span', { class: 'muted' }, `+${dsigs.length - 3} more`));

      const when = r.finishedAt ?? r.startedAt;
      return h(
        'tr',
        {},
        h('th', { scope: 'row', class: 'when' }, h('span', {}, fmtDateTime(r.startedAt)), h('span', { class: 'sub', 'data-ago': String(when) }, `#${r.id} · ${timeAgo(when)}`)),
        h('td', {}, h('span', { class: `status s-${r.status.toLowerCase()}` }, STATUS_LABEL[r.status] ?? r.status)),
        h('td', { class: 'coins' }, coins),
        h('td', { class: 'num' }, bought.length > 0 ? fmtSol(spent, 3) : DASH),
        h('td', { class: 'num' }, fmtInt(r.transfersSent)),
        h('td', { class: 'sigs' }, ...(links.length > 0 ? links.flatMap((l, i) => (i === 0 ? [l] : [' ', l])) : [h('span', { class: 'muted' }, DASH)])),
      );
    });
    host.append(
      h(
        'div',
        { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Recent rounds table. Scrolls sideways on small screens.' },
        h(
          'table',
          { class: 'data' },
          h(
            'thead',
            {},
            h('tr', {}, h('th', { scope: 'col' }, 'Round'), h('th', { scope: 'col' }, 'Status'), h('th', { scope: 'col' }, 'Coins bought'), h('th', { scope: 'col', class: 'num' }, 'SOL spent'), h('th', { scope: 'col', class: 'num' }, 'Transfers'), h('th', { scope: 'col' }, 'Transactions')),
          ),
          h('tbody', {}, ...rows),
        ),
      ),
    );
    if (s.totals.rounds > 0) {
      host.append(
        h('p', { class: 'note' }, `All time: ${fmtInt(s.totals.roundsRun)} rounds run, ${fmtSol(lamportsToSol(s.totals.spentLamports), 2)} spent, ${fmtInt(s.totals.transfersSent)} transfers to ${fmtInt(s.totals.walletsPaid)} wallets.`),
      );
    }
  });
  // keep "x min ago" labels fresh without rebuilding the table
  document.querySelectorAll<HTMLElement>('[data-ago]').forEach((el) => {
    const t = Number(el.dataset.ago);
    const id = el.textContent?.split(' · ')[0] ?? '';
    const next = `${id} · ${timeAgo(t)}`;
    if (el.textContent !== next) el.textContent = next;
  });
}

// ---------- boot ----------

initThemeToggle();
initWalletChecker(() => ({ state: model.state, owed: model.owed, preview: model.owedPreview }));
void poll();
setInterval(() => void poll(), POLL_MS);
// Relative times tick between polls.
setInterval(() => render(), 20_000);
