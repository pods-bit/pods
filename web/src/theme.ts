type Theme = 'light' | 'dark';
const KEY = 'pod5-theme';

function systemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function currentTheme(): Theme {
  const t = document.documentElement.getAttribute('data-theme');
  return t === 'light' || t === 'dark' ? t : systemTheme();
}

/** The saved theme is applied by an inline script in <head> (no flash); this wires the toggle. */
export function initThemeToggle(): void {
  const btn = document.getElementById('themeToggle') as HTMLButtonElement | null;
  if (!btn) return;
  const sync = (): void => {
    const dark = currentTheme() === 'dark';
    btn.setAttribute('aria-pressed', String(dark));
    btn.setAttribute('aria-label', dark ? 'Dark theme on. Switch to light theme' : 'Light theme on. Switch to dark theme');
    btn.dataset.mode = dark ? 'dark' : 'light';
  };
  btn.addEventListener('click', () => {
    const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* storage can be unavailable; the theme still applies for this visit */
    }
    sync();
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', sync);
  sync();
}
