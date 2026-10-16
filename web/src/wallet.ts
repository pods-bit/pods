import type { OwedSnapshot, PublicState } from '../../shared/types';
import { getTokenBalance, getUsdPrice } from './data';
import { clear, externalLink, h, $ } from './dom';
import { fmtRaw, fmtUsd, isBase58Address, shortAddr, solscanAccount } from './format';

export interface WalletContext {
  state: PublicState | null;
  owed: OwedSnapshot | null;
  /** True when state/owed came from the bundled sample. */
  preview: boolean;
}

interface CoinMeta {
  symbol: string;
  decimals: number;
  image: string;
}

/** mint -> display info from the basket and every round receipt we know about. */
function coinIndex(state: PublicState | null): Map<string, CoinMeta> {
  const m = new Map<string, CoinMeta>();
  if (!state) return m;
  for (const r of state.rounds) for (const b of r.basket) m.set(b.mint, { symbol: b.symbol, decimals: b.decimals, image: '' });
  for (const c of state.basket) m.set(c.mint, { symbol: c.symbol, decimals: c.decimals, image: c.image });
  return m;
}

function bigSum(a: string | undefined): bigint {
  return a && /^\d+$/.test(a) ? BigInt(a) : 0n;
}

export function initWalletChecker(getCtx: () => WalletContext): void {
  const form = $<HTMLFormElement>('walletForm');
  const input = $<HTMLInputElement>('walletInput');
  const out = $('walletResult');
  const err = $('walletError');
  const sampleBtn = $<HTMLButtonElement>('walletSample');
  let seq = 0;

  const setError = (msg: string): void => {
    err.textContent = msg;
    input.setAttribute('aria-invalid', msg ? 'true' : 'false');
  };

  sampleBtn.addEventListener('click', () => {
    const ctx = getCtx();
    const first = ctx.preview && ctx.owed ? Object.keys(ctx.owed.delivered)[0] : undefined;
    if (first) {
      input.value = first;
      form.requestSubmit();
    }
  });

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const addr = input.value.trim();
    clear(out);
    if (!isBase58Address(addr)) {
      setError('That does not look like a Solana address. It should be 32 to 44 letters and numbers (no 0, O, I or l).');
      return;
    }
    setError('');
    void check(addr);
  });

  async function check(addr: string): Promise<void> {
    const mine = ++seq;
    const ctx = getCtx();
    const meta = coinIndex(ctx.state);
    clear(out);
    out.append(h('p', { class: 'muted' }, 'Checking…'));

    // 1) Delivered / pending from the keeper's published snapshot (local lookup, nothing is sent anywhere).
    const delivered = ctx.owed?.delivered[addr] ?? {};
    const pending = ctx.owed?.owed[addr] ?? {};
    const mints = [...new Set([...Object.keys(delivered), ...Object.keys(pending)])];

    const body = h('div');
    if (ctx.preview) body.append(h('p', {}, h('span', { class: 'chip-preview' }, 'Preview data'), ' Showing the bundled sample, not real balances.'));

    if (!ctx.owed) {
      body.append(h('p', { class: 'muted' }, 'The keeper’s share ledger could not be loaded right now, so delivered and pending amounts are unavailable.'));
    } else if (mints.length === 0) {
      body.append(
        h('p', {}, 'No shares found for this wallet in the latest snapshot. Either no round has credited it yet, or it did not hold enough POD5 when rounds ran.'),
      );
    } else {
      const rows = mints.map((mint) => {
        const m = meta.get(mint);
        const dec = m?.decimals ?? 6;
        return h(
          'tr',
          {},
          h('th', { scope: 'row', class: 'coin-cell' }, m?.symbol ?? shortAddr(mint)),
          h('td', { class: 'num' }, fmtRaw(delivered[mint], dec)),
          h('td', { class: 'num' }, bigSum(pending[mint]) > 0n ? fmtRaw(pending[mint], dec) : '0'),
        );
      });
      body.append(
        h(
          'div',
          { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Delivered and pending shares for this wallet' },
          h(
            'table',
            { class: 'data compact' },
            h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Coin'), h('th', { scope: 'col', class: 'num' }, 'Delivered, all time'), h('th', { scope: 'col', class: 'num' }, 'Pending'))),
            h('tbody', {}, ...rows),
          ),
        ),
        h('p', { class: 'note' }, 'Pending shares are credited but waiting until they are worth more than the token-account rent. They send on their own.'),
      );
    }

    // 2) Qualification: needs the POD5 mint, a balance from the chain and a price.
    const qual = h('p', { 'aria-live': 'polite' });
    body.append(qual);
    const mint = ctx.state?.pod5Mint;
    const minHold = ctx.state?.minHoldUsd ?? 30;
    if (!mint) {
      qual.textContent = `Qualification check: available once POD5 has launched. You need $${minHold} of POD5 when a round runs.`;
    } else {
      qual.textContent = 'Reading your POD5 balance…';
    }
    body.append(h('p', {}, externalLink(solscanAccount(addr), `View ${shortAddr(addr)} on Solscan`)));

    if (mine !== seq) return;
    clear(out);
    out.append(body);

    if (mint) {
      try {
        const [bal, price] = await Promise.all([getTokenBalance(addr, mint), getUsdPrice(mint).catch(() => null).then((p) => p ?? ctx.state?.pod5PriceUsd ?? null)]);
        if (mine !== seq) return;
        const balStr = bal.toLocaleString('en-US', { maximumFractionDigits: 2 });
        if (price === null) {
          qual.textContent = `Holds ${balStr} POD5. A live USD price is not available, so we cannot say whether that clears $${minHold}.`;
        } else {
          const usd = bal * price;
          qual.textContent =
            usd >= minHold
              ? `Qualifies: holds ${balStr} POD5 (about ${fmtUsd(usd)}), above the $${minHold} line.`
              : `Not yet: holds ${balStr} POD5 (about ${fmtUsd(usd)}). The line is $${minHold}.`;
        }
      } catch {
        if (mine !== seq) return;
        qual.textContent = `Qualification check unavailable right now because the RPC node did not answer. You need $${minHold} of POD5 when a round runs.`;
      }
    }
  }
}
