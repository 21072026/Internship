import { DarkTheme, DefaultTheme, type Theme } from 'expo-router';
import { useColorScheme } from 'react-native';

// Light and dark palettes for the native screens (#2775), taken from the web's
// own Tailwind grays (bg-gray-50/950, gray-900 cards, gray-800 borders) so a
// native screen and the web page next to it in the same app look like one
// product. The scheme follows the phone — the same `prefers-color-scheme` the
// web view's page follows unless the person picked a theme on the site, in
// which case WebScreen takes the page's colours for its own header.

export interface Palette {
  bg: string;
  card: string;
  text: string;
  muted: string;
  faint: string;
  border: string;
  inputBorder: string;
  subtle: string;
  highlight: string;
  danger: string;
}

const LIGHT: Palette = {
  bg: '#ffffff',
  card: '#ffffff',
  text: '#111827',
  muted: '#6b7280',
  faint: '#9ca3af',
  border: '#e5e7eb',
  inputBorder: '#d1d5db',
  subtle: '#f3f4f6',
  highlight: '#f8fafc',
  danger: '#b91c1c',
};

const DARK: Palette = {
  bg: '#030712',
  card: '#111827',
  text: '#f3f4f6',
  muted: '#9ca3af',
  faint: '#6b7280',
  border: '#1f2937',
  inputBorder: '#374151',
  subtle: '#1f2937',
  highlight: '#0b1220',
  danger: '#f87171',
};

export function useAppTheme(): { dark: boolean; c: Palette } {
  const dark = useColorScheme() === 'dark';
  return { dark, c: dark ? DARK : LIGHT };
}

/** The navigation theme (headers, tab bar, screen background) for a scheme and brand tint. */
export function navigationTheme(dark: boolean, tint: string): Theme {
  const base = dark ? DarkTheme : DefaultTheme;
  const c = dark ? DARK : LIGHT;
  return {
    ...base,
    colors: { ...base.colors, primary: tint, background: c.bg, card: c.card, text: c.text, border: c.border },
  };
}
