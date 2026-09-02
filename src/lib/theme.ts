// Single source of truth for the user-selectable colour theme.
//
// Three states, not two (#2078): `system` is a real, persisted value — not the
// absence of a preference — so a user who once tapped the sidebar toggle can
// get back to following the OS. The no-flash script in src/app/layout.tsx
// resolves `system` via matchMedia before paint; keep the two in sync.
export const THEMES = ['system', 'light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

// Cycle order of the sidebar toggle: system → light → dark → system.
export const THEME_CYCLE: Theme[] = ['system', 'light', 'dark'];

export function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value);
}

export function resolveTheme(preference?: string | null): Theme {
  return isTheme(preference) ? preference : 'system';
}

// Does this preference paint dark right now? `system` asks the OS.
export function prefersDark(theme: Theme): boolean {
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;
}

// The choice in effect on this device — the same lookup order as the pre-paint
// script in src/app/layout.tsx: cookie, then localStorage, then the preference
// the server resolved for this request (which covers a signed-in user whose
// preference lives only in the account). Client-only.
export function readStoredTheme(): Theme {
  const m = document.cookie.match(/(?:^|; )theme=([^;]+)/);
  if (m) return resolveTheme(decodeURIComponent(m[1]));
  let stored: string | null = null;
  try { stored = localStorage.getItem('theme'); } catch { /* ignore */ }
  return resolveTheme(stored ?? document.documentElement.getAttribute('data-theme-pref'));
}

// Apply + persist on this device. `system` is written out like any other value
// so the pre-paint script can resolve it: an absent cookie is indistinguishable
// from "never chose", which is what made "system" unreachable before.
export function applyTheme(next: Theme) {
  document.documentElement.classList.toggle('dark', prefersDark(next));
  try { localStorage.setItem('theme', next); } catch { /* ignore */ }
  document.cookie = `theme=${next}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
}
