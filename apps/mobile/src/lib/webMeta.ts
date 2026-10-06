// How an in-app web page and the native shell talk (#2775). Dependency-free so
// `npm test` pins it.
//
// The web view's User-Agent carries `InternCRMApp/1` (WebScreen), and the
// server answers with <html data-embedded-app>: the site's own top bar, drawer
// and install prompt carry `data-app-chrome` and hide themselves
// (src/lib/embeddedApp.ts, src/app/globals.css), because the app draws those
// natively. After load the page reports its title and colours, and again whenever they
// change (client-side navigation rewrites <title>; the theme toggle flips
// html.dark), so the native header shows the page's name in the page's colours.

/** Runs after load: report title + theme, and keep reporting on change. */
export const AFTER_LOAD_JS = `
  (function () {
    function report() {
      var html = document.documentElement;
      var bg = window.getComputedStyle(document.body || html).backgroundColor;
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'meta',
        title: document.title || '',
        dark: html.classList.contains('dark'),
        bg: bg
      }));
    }
    report();
    var t = null;
    var later = function () { clearTimeout(t); t = setTimeout(report, 50); };
    new MutationObserver(later).observe(document.head, { subtree: true, childList: true, characterData: true });
    new MutationObserver(later).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  })();
  true;
`;

export interface PageMeta {
  title: string;
  dark: boolean;
  /** Hex colour of the page background, when it could be read. */
  bg: string | null;
}

/** `rgb(3, 7, 18)` / `rgba(…, 1)` → `#030712`; a transparent or unreadable value → null. */
export function cssColorToHex(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = value.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
  if (!m) return /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : null;
  if (m[4] !== undefined && Number(m[4]) === 0) return null;
  return `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The page's own name, without the site-wide suffix the title template adds
 * (`%s · <product>`, src/app/layout.tsx) — the app already says which product
 * it is. Only a title carrying that suffix names a page: one without it is the
 * site's default (a page that set no title of its own, e.g. a role dashboard),
 * and gives '' so the header keeps the menu label the screen was opened with.
 */
export function pageTitle(raw: string, productName: string): string {
  const title = raw.trim();
  const suffix = ` · ${productName}`;
  return title.endsWith(suffix) ? title.slice(0, -suffix.length).trim() : '';
}

/** Parse a message from the page; anything that is not a well-formed meta report is null. */
export function parsePageMeta(data: string): PageMeta | null {
  try {
    const msg = JSON.parse(data) as { type?: unknown; title?: unknown; dark?: unknown; bg?: unknown };
    if (msg.type !== 'meta' || typeof msg.title !== 'string') return null;
    return { title: msg.title, dark: msg.dark === true, bg: cssColorToHex(msg.bg) };
  } catch {
    return null;
  }
}

/** Whether a #rrggbb background wants light text (relative luminance below the midpoint). */
export function isDarkColor(hex: string): boolean {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return false;
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => parseInt(h, 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5;
}
