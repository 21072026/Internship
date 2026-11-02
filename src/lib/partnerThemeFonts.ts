// The fonts a partner-page theme may name (#3535, FONT_KEYS in
// src/lib/affiliateLandingRule.ts), self-hosted by next/font: the files are
// fetched once at build time and served from /_next/static, so a visitor's
// browser never calls a font CDN (CSP `font-src 'self'`, and no third party
// learns who reads the page). `preload: false` — a page loads only the one or
// two families its theme uses, when its text first needs them.
import { DM_Sans, Inter, Lato, Manrope, Merriweather, Montserrat, Nunito, Open_Sans, Playfair_Display, Poppins, Raleway, Roboto } from 'next/font/google';
import type { FontKey } from '@/lib/affiliateLandingRule';

// next/font wants every argument written out as a literal, so the options repeat.
const inter = Inter({ subsets: ['latin', 'latin-ext'], display: 'swap', preload: false });
const roboto = Roboto({ subsets: ['latin', 'latin-ext'], display: 'swap', preload: false });
const openSans = Open_Sans({ subsets: ['latin', 'latin-ext'], display: 'swap', preload: false });
const lato = Lato({ subsets: ['latin', 'latin-ext'], display: 'swap', preload: false, weight: ['400', '700', '900'] });
const montserrat = Montserrat({ subsets: ['latin', 'latin-ext'], display: 'swap', preload: false });
const poppins = Poppins({ subsets: ['latin', 'latin-ext'], display: 'swap', preload: false, weight: ['400', '500', '600', '700', '800'] });
const manrope = Manrope({ subsets: ['latin', 'latin-ext'], display: 'swap', preload: false });
const nunito = Nunito({ subsets: ['latin', 'latin-ext'], display: 'swap', preload: false });
const raleway = Raleway({ subsets: ['latin', 'latin-ext'], display: 'swap', preload: false });
const dmSans = DM_Sans({ subsets: ['latin', 'latin-ext'], display: 'swap', preload: false });
const playfair = Playfair_Display({ subsets: ['latin', 'latin-ext'], display: 'swap', preload: false });
const merriweather = Merriweather({ subsets: ['latin', 'latin-ext'], display: 'swap', preload: false });

const FONTS: Record<FontKey, { style: { fontFamily: string }; label: string }> = {
  inter: { style: inter.style, label: 'Inter' },
  roboto: { style: roboto.style, label: 'Roboto' },
  'open-sans': { style: openSans.style, label: 'Open Sans' },
  lato: { style: lato.style, label: 'Lato' },
  montserrat: { style: montserrat.style, label: 'Montserrat' },
  poppins: { style: poppins.style, label: 'Poppins' },
  manrope: { style: manrope.style, label: 'Manrope' },
  nunito: { style: nunito.style, label: 'Nunito' },
  raleway: { style: raleway.style, label: 'Raleway' },
  'dm-sans': { style: dmSans.style, label: 'DM Sans' },
  'playfair-display': { style: playfair.style, label: 'Playfair Display' },
  merriweather: { style: merriweather.style, label: 'Merriweather' },
};

/** The CSS font-family of a theme font (next/font's generated family name plus its fallback). */
export function themeFontFamily(key: FontKey): string {
  return FONTS[key].style.fontFamily;
}

/** The font's own name, for the editor's list (a proper noun: not translated). */
export function themeFontLabel(key: FontKey): string {
  return FONTS[key].label;
}
