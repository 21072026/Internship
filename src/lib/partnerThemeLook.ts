// How a partner-page theme (#3535, src/lib/affiliateLandingRule.ts) turns into
// styles — shared by the page (src/app/partner/ThemedPartnerPage.tsx) and the
// editor's preview, so the sketch an admin sees is drawn by the same mapping.
// Client-safe: no fonts, no Prisma.
//
// Every colour is an inline style from the palette, never a Tailwind colour
// class: the flat dark-mode overrides in globals.css (`html.dark .bg-white` …)
// would otherwise repaint parts of a page whose colours were checked as one
// set. A themed page therefore looks the same in dark mode, by design.
import type { CSSProperties } from 'react';
import { themePalette, type LandingTheme, type ThemeMediaSlot, type ThemePalette } from '@/lib/affiliateLandingRule';

/** What a page needs to render a theme's media: the URL and kind per slot (an absent slot shows nothing). */
export type ThemeMedia = Partial<Record<ThemeMediaSlot, { url: string; kind: 'image' | 'video' }>>;

/** Large text in the WCAG sense (≥ 18.66px bold): what lets a themed button use 3:1 (affiliateLandingRule). */
export const LARGE_BUTTON = 'inline-flex items-center justify-center gap-2 px-6 py-3 text-[1.1875rem] font-bold leading-tight transition hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2';

const RADIUS = {
  square: { card: '0', button: '0' },
  rounded: { card: '0.75rem', button: '0.5rem' },
  large: { card: '1.5rem', button: '9999px' },
} as const;

export interface ThemeLook {
  p: ThemePalette;
  gradient: string;
  card: CSSProperties;
  button: (fill: 'primary' | 'secondary') => CSSProperties;
  /** An outlined button on a fill or the page: border and text in `ink`. */
  outline: (ink: string) => CSSProperties;
  buttonRadius: string;
  cardRadius: string;
  /** The scrim over a hero picture or video, or null for none. */
  overlay: CSSProperties | null;
}

export function themeLook(theme: LandingTheme): ThemeLook {
  const p = themePalette(theme);
  const r = RADIUS[theme.corners];
  const gradient = `linear-gradient(135deg, ${p.primary}, ${p.secondary})`;
  const card: CSSProperties = {
    backgroundColor: p.surface,
    color: p.text,
    borderRadius: r.card,
    ...(theme.cardStyle === 'shadow' ? { boxShadow: '0 1px 3px rgba(0,0,0,0.08), 0 12px 32px -12px rgba(0,0,0,0.18)' } : {}),
    // The text colour at ~20 % for the outline: visible on any surface the contrast check accepted.
    ...(theme.cardStyle === 'outline' ? { border: `1px solid ${p.text}33` } : {}),
  };
  return {
    p,
    gradient,
    card,
    button: (fill) => ({
      backgroundColor: fill === 'primary' ? p.primary : p.secondary,
      color: fill === 'primary' ? p.onPrimary : p.onSecondary,
      borderRadius: r.button,
      outlineColor: fill === 'primary' ? p.primary : p.secondary,
    }),
    outline: (ink) => ({ border: `2px solid ${ink}`, color: ink, borderRadius: r.button, outlineColor: ink }),
    buttonRadius: r.button,
    cardRadius: r.card,
    overlay:
      theme.heroOverlay === 'brand'
        ? { background: gradient, opacity: 0.75 }
        : theme.heroOverlay === 'dark'
          ? { backgroundColor: '#000000', opacity: 0.55 }
          : null,
  };
}

/** Text over a picture or video with no scrim: a shadow keeps it legible on a busy image. */
export const TEXT_SHADOW: CSSProperties = { textShadow: '0 1px 3px rgba(0,0,0,0.6)' };
