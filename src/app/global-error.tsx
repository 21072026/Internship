'use client';

import { useEffect, useState } from 'react';
import { reportBoundaryError } from '@/lib/reportBoundaryError';

/**
 * The last boundary: it catches a throw in the **root layout itself** (#1602).
 *
 * Next.js replaces the entire document with this component, so it renders its
 * own `<html>` and `<body>` — and, crucially, nothing above it survives:
 * `Providers` never mounted, so there is no `LocaleProvider` (no `useT()`), no
 * `SessionProvider`, and `globals.css` — imported by the root layout that just
 * failed — cannot be relied on either. Reaching for any of those is how a
 * global-error boundary turns into a blank white page at exactly the moment
 * everything else has already broken.
 *
 * Hence: zero component imports, the copy inlined per locale, and all styling
 * in one inline `<style>` block. The only import is the error reporter, which
 * is a dependency-free console/tracker funnel.
 */

type Copy = { title: string; description: string; retry: string; home: string; reference: string };

// Deliberately NOT read from src/i18n/dictionaries.ts: that module is the whole
// app dictionary and pulling it in here would make the one chunk that has to
// work when everything else is broken the largest one. Three short strings ×
// three locales is the cheaper trade. Keep the wording in step with
// `errorBoundary.*` in the dictionaries if that copy changes.
const COPY: Record<'en' | 'tr' | 'de', Copy> = {
  en: {
    title: 'Something went wrong',
    description: 'The application ran into an unexpected error and could not finish loading. Reloading usually fixes it.',
    retry: 'Try again',
    home: 'Back to home',
    reference: 'Error reference:',
  },
  tr: {
    title: 'Bir şeyler ters gitti',
    description: 'Uygulama beklenmeyen bir hatayla karşılaştı ve yüklenmeyi tamamlayamadı. Sayfayı yeniden yüklemek genellikle sorunu çözer.',
    retry: 'Tekrar dene',
    home: 'Ana sayfaya dön',
    reference: 'Hata referansı:',
  },
  de: {
    title: 'Etwas ist schiefgelaufen',
    description: 'In der Anwendung ist ein unerwarteter Fehler aufgetreten, das Laden konnte nicht abgeschlossen werden. Ein Neuladen behebt das meistens.',
    retry: 'Erneut versuchen',
    home: 'Zurück zur Startseite',
    reference: 'Fehlerreferenz:',
  },
};

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
  return match ? decodeURIComponent(match[1]) : null;
}

// The language this device should read, without the server.
//
// The `locale` cookie is only written when someone uses the language switcher.
// A user whose preference lives on their *account* (`User.preferredLanguage`,
// set in /account) has no cookie on a device they have just signed in on —
// getLocale() resolves it server-side, which is exactly the thing that is not
// available here. `navigator.language` is the next best signal: it is what the
// browser is set to, and for the overwhelming majority of users it agrees with
// the app language. Better a good guess than a hard-coded 'en' on the one
// screen a person sees when everything else has failed.
function detectLocale(): 'en' | 'tr' | 'de' {
  const cookie = readCookie('locale');
  if (cookie === 'tr' || cookie === 'de' || cookie === 'en') return cookie;
  const nav = typeof navigator === 'undefined' ? '' : (navigator.language || '').toLowerCase();
  if (nav.startsWith('tr')) return 'tr';
  if (nav.startsWith('de')) return 'de';
  return 'en';
}

// Same precedence as readStoredTheme() in src/lib/theme.ts: cookie, then
// localStorage. (Its third step — the root layout's `data-theme-pref`, which
// carries the account preference — is unreachable here: this component renders
// its own <html>, so the attribute the failed layout would have stamped is
// gone by the time this runs. localStorage covers the same user on any device
// they have actually used the app on.) 'system' resolves to `undefined` so the
// prefers-color-scheme rule in STYLES decides, which is what it means.
function detectTheme(): 'dark' | 'light' | undefined {
  const cookie = readCookie('theme');
  if (cookie === 'dark' || cookie === 'light') return cookie;
  if (cookie === 'system') return undefined;
  let stored: string | null = null;
  try {
    stored = localStorage.getItem('theme');
  } catch {
    /* storage can be blocked; the OS preference is a fine fallback */
  }
  return stored === 'dark' || stored === 'light' ? stored : undefined;
}

// Light values are the defaults; the dark set is applied by the OS preference
// and overridden by an explicit stored theme (see detectTheme), which is the
// same precedence the root layout's no-flash script uses. Plain CSS variables
// rather than Tailwind utilities — the stylesheet may not be there.
const STYLES = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
.ge-body {
  --bg: #f9fafb; --card: #ffffff; --fg: #111827; --muted: #4b5563;
  --border: #e5e7eb; --accent: #2563eb; --accent-hover: #1d4ed8;
  --accent-fg: #ffffff; --danger: #dc2626; --code: #374151; --code-bg: #f3f4f6;
  margin: 0; min-height: 100vh; background: var(--bg); color: var(--fg);
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  display: flex; align-items: center; justify-content: center; padding: 24px;
}
@media (prefers-color-scheme: dark) {
  .ge-body:not([data-theme="light"]) {
    --bg: #030712; --card: #111827; --fg: #f3f4f6; --muted: #9ca3af;
    --border: #1f2937; --accent: #3b82f6; --accent-hover: #2563eb;
    --accent-fg: #ffffff; --danger: #f87171; --code: #d1d5db; --code-bg: #1f2937;
  }
}
.ge-body[data-theme="dark"] {
  --bg: #030712; --card: #111827; --fg: #f3f4f6; --muted: #9ca3af;
  --border: #1f2937; --accent: #3b82f6; --accent-hover: #2563eb;
  --accent-fg: #ffffff; --danger: #f87171; --code: #d1d5db; --code-bg: #1f2937;
}
.ge-card {
  width: 100%; max-width: 28rem; background: var(--card); border: 1px solid var(--border);
  border-radius: 12px; padding: 32px 24px; text-align: center;
  box-shadow: 0 1px 3px rgba(0,0,0,0.08);
}
.ge-icon { color: var(--danger); display: block; margin: 0 auto 16px; }
.ge-title { margin: 0; font-size: 1.25rem; line-height: 1.75rem; font-weight: 700; color: var(--fg); }
.ge-text { margin: 8px 0 0; font-size: 0.875rem; line-height: 1.5rem; color: var(--muted); }
.ge-ref { margin: 12px 0 0; font-size: 0.75rem; color: var(--muted); }
.ge-ref code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  background: var(--code-bg); color: var(--code); border-radius: 4px; padding: 1px 5px;
}
.ge-actions { margin-top: 24px; display: flex; flex-wrap: wrap; gap: 12px; justify-content: center; }
.ge-btn {
  display: inline-flex; align-items: center; justify-content: center;
  min-height: 44px; padding: 10px 18px; border-radius: 8px; font: inherit;
  font-size: 0.875rem; font-weight: 500; cursor: pointer; text-decoration: none;
  border: 1px solid transparent; transition: background-color .15s, color .15s;
}
.ge-btn-primary { background: var(--accent); color: var(--accent-fg); }
.ge-btn-primary:hover { background: var(--accent-hover); }
.ge-btn-outline { background: transparent; color: var(--fg); border-color: var(--border); }
.ge-btn-outline:hover { background: var(--code-bg); }
.ge-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
`;

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  // The first paint happens before any of this can run (and may happen on the
  // server), so it uses the English copy and the OS colour preference. The
  // device's own signals refine it on mount — resolving them in state rather
  // than during render is what keeps the server and client markup identical.
  const [locale, setLocale] = useState<'en' | 'tr' | 'de'>('en');
  const [theme, setTheme] = useState<'dark' | 'light' | undefined>(undefined);

  useEffect(() => {
    reportBoundaryError(error, { scope: 'global', digest: error.digest });
  }, [error]);

  useEffect(() => {
    setLocale(detectLocale());
    setTheme(detectTheme());
  }, []);

  const copy = COPY[locale];

  return (
    <html lang={locale} suppressHydrationWarning>
      <body className="ge-body" data-theme={theme} suppressHydrationWarning>
        <style dangerouslySetInnerHTML={{ __html: STYLES }} />
        <div className="ge-card" role="alert" data-testid="global-error">
          <svg
            className="ge-icon"
            width="40"
            height="40"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
            <path d="M12 9v4" />
            <path d="M12 17h.01" />
          </svg>
          <h1 className="ge-title">{copy.title}</h1>
          <p className="ge-text">{copy.description}</p>
          {/* The digest and nothing else: the message and stack can carry ids,
              paths and query fragments, and this screen is user-facing. */}
          {error.digest && (
            <p className="ge-ref">
              {copy.reference} <code data-testid="global-error-digest">{error.digest}</code>
            </p>
          )}
          <div className="ge-actions">
            <button type="button" className="ge-btn ge-btn-primary" onClick={() => reset()} data-testid="global-error-retry">
              {copy.retry}
            </button>
            {/* A plain <a>, not next/link, on purpose: a client-side navigation
                would keep the broken tree alive, and the root layout that just
                threw is exactly what needs to be re-run. A hard load does that. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a className="ge-btn ge-btn-outline" href="/" data-testid="global-error-home">
              {copy.home}
            </a>
          </div>
        </div>
      </body>
    </html>
  );
}
