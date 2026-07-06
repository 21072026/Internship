// Single source of truth for the user-selectable accent color.
//
// The accent recolors the app's primary (blue-by-default) palette via a
// `data-accent` attribute on <html>, mapped to CSS custom properties in
// globals.css. Keep this list in sync with the html[data-accent="…"] palette
// blocks there.
import { IS_PREVIEW } from '@/lib/appEnv';

export const ACCENT_COLORS = ['blue', 'green', 'purple', 'rose', 'teal', 'amber'] as const;
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
};

export function isAccentColor(value: unknown): value is AccentColor {
  return typeof value === 'string' && (ACCENT_COLORS as readonly string[]).includes(value);
}

// The default when the user hasn't chosen one: green on the preview deployment
// (so it's never mistaken for production), blue everywhere else.
export const DEFAULT_ACCENT: AccentColor = IS_PREVIEW ? 'green' : 'blue';

// Resolve the accent to apply: an explicit user preference wins, otherwise the
// environment default. Returns the value for the <html data-accent> attribute.
export function resolveAccent(preference?: string | null): AccentColor {
  return isAccentColor(preference) ? preference : DEFAULT_ACCENT;
}
