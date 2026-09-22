// Single source of truth for the user-selectable accent color.
//
// The accent recolors the app's primary (blue-by-default) palette via a
// `data-accent` attribute on <html>, mapped to CSS custom properties in
// globals.css. Keep this list in sync with the html[data-accent="…"] palette
// blocks there.
import { IS_PREVIEW } from '@/lib/appEnv';
import type { VerticalKey } from '@/lib/verticals';

// 'magenta' is SaleVali's brand (#2492): the MARKETING vertical's default, and
// pickable by anyone. Its 600 (#b929cf) sits between the brand primary #cc33e5
// (kept at 500, fills only) and the brand dark #9b1dbd (700) so white button
// text clears WCAG AA (4.9:1) — the primary itself is 4.1:1 and does not.
export const ACCENT_COLORS = ['blue', 'green', 'purple', 'rose', 'teal', 'amber', 'magenta'] as const;
export type AccentColor = (typeof ACCENT_COLORS)[number];

// The 600-shade of each palette, for rendering the picker swatches (Tailwind
// can't generate classes from runtime values, so the swatch uses an inline
// backgroundColor). Mirrors the palettes in globals.css.
export const ACCENT_SWATCH: Record<AccentColor, string> = {
  blue: '#2563eb',
  green: '#16a34a',
  purple: '#9333ea',
  rose: '#e11d48',
  teal: '#0d9488',
  amber: '#d97706',
  magenta: '#b929cf',
};

export function isAccentColor(value: unknown): value is AccentColor {
  return typeof value === 'string' && (ACCENT_COLORS as readonly string[]).includes(value);
}

// The default when the user hasn't chosen one: green on the preview deployment
// (so it's never mistaken for production), blue everywhere else.
export const DEFAULT_ACCENT: AccentColor = IS_PREVIEW ? 'green' : 'blue';

// The browser-UI tint (`theme-color` meta, manifest `theme_color`) per vertical
// (#2492): SaleVali magenta-600 on a marketing host, the internship blue-700
// everywhere else. Read by both viewport exports (root + /messages) and the
// manifest, so the three cannot drift — a SaleVali install whose Messages
// shortcut painted the status bar blue was the drift this closes.
export const THEME_COLOR: Record<VerticalKey, string> = { INTERNSHIP: '#1D4ED8', MARKETING: '#b929cf' };
export function themeColorFor(vertical?: VerticalKey | null): string {
  return vertical === 'MARKETING' ? THEME_COLOR.MARKETING : THEME_COLOR.INTERNSHIP;
}

// The accent a vertical wears when nobody chose one (#2492): SaleVali's magenta
// for MARKETING, the environment default (blue; green on preview) otherwise.
export function defaultAccentFor(vertical?: VerticalKey | null): AccentColor {
  return vertical === 'MARKETING' ? 'magenta' : DEFAULT_ACCENT;
}

// Resolve the accent to apply: an explicit user preference wins, otherwise the
// vertical's default. Returns the value for the <html data-accent> attribute.
export function resolveAccent(preference?: string | null, vertical?: VerticalKey | null): AccentColor {
  return isAccentColor(preference) ? preference : defaultAccentFor(vertical);
}
