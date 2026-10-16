/** Tiny DOM helpers. All dynamic text goes through textContent, never innerHTML. */

type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | undefined> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (v === true) el.setAttribute(k, '');
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v);
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
}

export function setText(id: string, text: string): void {
  const el = document.getElementById(id);
  if (el && el.textContent !== text) el.textContent = text;
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** Only allow https image URLs (Pod serves relative /img paths). */
export function safeImage(src: string | undefined): string | null {
  if (!src) return null;
  if (src.startsWith('/img/')) return `https://orcapod.fun${src}`;
  return /^https:\/\//i.test(src) ? src : null;
}

export function externalLink(href: string, text: string, cls?: string): HTMLAnchorElement {
  return h('a', { href, target: '_blank', rel: 'noopener noreferrer', class: cls }, text);
}
