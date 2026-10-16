import './styles.css';
import type { PublicState } from '../../shared/types';
import { DATA_BASE, SAMPLE_BASE, tradeUrl } from './config';
import { solscanAccount } from './format';
import { initThemeToggle } from './theme';

initThemeToggle();

// Open the FAQ item that a #hash points at, and highlight the current section in the contents list.
const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('.toc a'));
const sections = links
  .map((a) => document.getElementById(a.hash.slice(1)))
  .filter((el): el is HTMLElement => el !== null);

if ('IntersectionObserver' in window) {
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        for (const a of links) {
          if (a.hash === `#${e.target.id}`) a.setAttribute('aria-current', 'location');
          else a.removeAttribute('aria-current');
        }
      }
    },
    { rootMargin: '-20% 0px -70% 0px' },
  );
  sections.forEach((s) => io.observe(s));
}

// Best effort: point the Trade button and footer at the real POD5 mint / keeper wallet once published.
void (async () => {
  try {
    let res = await fetch(`${DATA_BASE}/state.json`, { cache: 'no-cache' });
    if (!res.ok) res = await fetch(`${SAMPLE_BASE}/state.json`);
    const s = (await res.json()) as Partial<PublicState>;
    const btn = document.getElementById('tradeBtn') as HTMLAnchorElement | null;
    if (btn) btn.href = tradeUrl(s.pod5Mint);
    const kw = document.getElementById('footKeeper') as HTMLAnchorElement | null;
    if (kw && s.keeperWallet) {
      kw.href = solscanAccount(s.keeperWallet);
      kw.hidden = false;
    }
  } catch {
    /* docs work without live data */
  }
})();
