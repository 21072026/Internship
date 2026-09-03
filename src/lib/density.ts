// Single source of truth for the user-selectable UI density (#2078).
//
// `compact` tightens container spacing only (table cells, list rows, card
// padding — see html.density-compact in globals.css); interactive targets keep
// their size, so nothing drops below the 44×44px floor. Off by default.
export const DENSITIES = ['comfortable', 'compact'] as const;
export type Density = (typeof DENSITIES)[number];

export const DENSITY_CLASS = 'density-compact';

export function isDensity(value: unknown): value is Density {
  return typeof value === 'string' && (DENSITIES as readonly string[]).includes(value);
}

export function resolveDensity(preference?: string | null): Density {
  return isDensity(preference) ? preference : 'comfortable';
}

// The choice in effect on this device — same lookup order as the pre-paint
// script in src/app/layout.tsx: cookie, then localStorage, then the preference
// the server resolved for this request. Client-only.
export function readStoredDensity(): Density {
  const m = document.cookie.match(/(?:^|; )density=([^;]+)/);
  if (m) return resolveDensity(decodeURIComponent(m[1]));
  let stored: string | null = null;
  try { stored = localStorage.getItem('density'); } catch { /* ignore */ }
  return resolveDensity(stored ?? document.documentElement.getAttribute('data-density-pref'));
}

// Apply + persist on this device — the same triple as the theme and font-size
// controls (class on <html>, localStorage, cookie).
export function applyDensity(next: Density) {
  document.documentElement.classList.toggle(DENSITY_CLASS, next === 'compact');
  try { localStorage.setItem('density', next); } catch { /* ignore */ }
  document.cookie = `density=${next}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
}
