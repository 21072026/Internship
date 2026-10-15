// Single source of truth for the user-selectable accent color.
//
// The accent recolors the app's primary (blue-by-default) palette via a
// `data-accent` attribute on <html>, mapped to CSS custom properties in
// globals.css. Keep this list in sync with the html[data-accent="…"] palette
// blocks there.
import { IS_PREVIEW } from '@/lib/appEnv';
import type { VerticalKey } from '@/lib/verticals';

// 'magenta' is a pickable accent on Tailwind's fuchsia ramp; its 600 (#c026d3)
// gives white button text 4.71:1, so it clears WCAG AA. The key keeps its name
// because people have it saved.
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
  magenta: '#c026d3',
};

export function isAccentColor(value: unknown): value is AccentColor {
  return typeof value === 'string' && (ACCENT_COLORS as readonly string[]).includes(value);
}

// The default when the user hasn't chosen one: green on the preview deployment
// (so it's never mistaken for production), blue everywhere else.
export const DEFAULT_ACCENT: AccentColor = IS_PREVIEW ? 'green' : 'blue';

// The browser-UI tint (`theme-color` meta, manifest `theme_color`) per vertical
// (#2492). Both worlds wear the product blue-700 by default: the worlds are told
// apart by their name, and an organization's own tint is data (`brandColor`,
// src/lib/brandRule.ts). Read by both viewport exports (root + /messages) and
// the manifest, so the three cannot drift.
export const THEME_COLOR: Record<VerticalKey, string> = { INTERNSHIP: '#1D4ED8', MARKETING: '#1D4ED8' };
export function themeColorFor(vertical?: VerticalKey | null): string {
  return vertical === 'MARKETING' ? THEME_COLOR.MARKETING : THEME_COLOR.INTERNSHIP;
}

// The accent a vertical wears when nobody chose one: the environment default
// (blue; green on preview) in every vertical. An organization's own default
// accent is data (`brandAccent`).
export function defaultAccentFor(_vertical?: VerticalKey | null): AccentColor {
  return DEFAULT_ACCENT;
}

// The accent a MAIL wears when its tenant set no brand colour: the product
// blue in every vertical. Never the preview green — a mail outlives the
// environment that sent it.
export function mailAccentFor(_vertical?: VerticalKey | null): string {
  return ACCENT_SWATCH.blue;
}

// Resolve the accent to apply: an explicit user preference wins, otherwise the
// vertical's default. Returns the value for the <html data-accent> attribute.
export function resolveAccent(preference?: string | null, vertical?: VerticalKey | null): AccentColor {
  return isAccentColor(preference) ? preference : defaultAccentFor(vertical);
}
