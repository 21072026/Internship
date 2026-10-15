// Per-organization brand — the pure rule (#2922).
//
// ZERO imports on purpose, so `node --test --experimental-strip-types` can load
// it (scripts/test/brand-rule.test.mjs) and every decision below is pinned
// without a database, a request or a browser. The Prisma half — reading the
// rows and caching them — is src/lib/hostBrand.ts; the image half is
// src/lib/brandRender.ts.
//
// WHAT A "BRAND" IS HERE. The things a person sees before they read a word: the
// product name an installed app carries, the browser tint, the app icon set,
// the accent palette. Each one has a product default per vertical (today's
// built-in values, read through the functions that already own them — this
// module never copies them), and an organization may override any of them as
// DATA on its own row:
//
//   brandName          the installed app's name
//   brandColor         browser tint (theme-color), mail accent, share card
//   brandTileColor     the tile behind the mark on every generated icon
//   brandAccent        the default accent: an accent key, or 'brand'
//   brandPalette       ten hexes (50…900) — the 'brand' accent's exact ramp
//   brandMarkVersion   which generated icon set (BrandAsset rows) is current
//
// THE TWO SOURCES, in the order a request resolves them:
//
//   1. Signed out, the HOST decides: the organization whose `publicHost` is the
//      request's exact hostname supplies the brand — but only when it is the
//      same product the host serves (one product's tenant never dresses the
//      other product's door) and it carries at least one brand field. Anything
//      else is the vertical's default, field for field.
//   2. Signed in, the person's OWN organization decides — never the host's
//      organization: a session is in exactly one tenant, and its chrome is that
//      tenant's.
//
// Whichever source wins, a field the organization left empty falls back to the
// default on its own. A brand is cosmetic: nothing here decides access, which is
// why the host-trust list in src/lib/hostVertical.ts does not grow.

/** The verticals, spelled out so this module needs no import. */
export type BrandVertical = 'INTERNSHIP' | 'MARKETING';

export type BrandSource = 'org' | 'default';

/** The brand columns of an `Organization` row (plus its vertical). */
export interface OrgBrandRow {
  vertical: string | null;
  brandName: string | null;
  brandColor: string | null;
  brandTileColor: string | null;
  brandAccent: string | null;
  brandPalette: string | null;
  brandMarkVersion: string | null;
}

/** What a vertical looks like when nobody set anything — supplied by the caller. */
export interface BrandDefaults {
  productName: string;
  themeColor: string;
  /** The vertical's default accent key. */
  accent: string;
}

/** The resolved brand, every field filled. */
export interface ResolvedBrandFields {
  source: BrandSource;
  productName: string;
  themeColor: string;
  /** The tile behind the mark; only consulted when there is a mark. */
  tileColor: string;
  /** The accent key a person who chose nothing wears: an accent key or 'brand'. */
  accent: string;
  /** The 'brand' accent's ramp (50…900), or null when the organization has none. */
  palette: string[] | null;
  /** The current generated icon set, or null for the vertical's static files. */
  markVersion: string | null;
}

/**
 * The brand a CLIENT component reads (BrandProvider). Null in the context means
 * "the vertical default" — every component keeps its own built-in rendering.
 */
export interface ClientBrand {
  productName: string;
  /** Same-origin URL of the bare mark (`/brand/<v>/mark-128.png`), or null. */
  markSrc: string | null;
  tileColor: string;
  palette: string[] | null;
  /** The accent a person who chose nothing wears. */
  defaultAccent: string;
}

/** The accent value that means "the organization's own palette". */
export const BRAND_ACCENT = 'brand';

// ── Text ─────────────────────────────────────────────────────────────────────

function clean(v: string | null | undefined): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length ? t : null;
}

// ── Colour ───────────────────────────────────────────────────────────────────

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** `#abc` / `#AABBCC` → `#aabbcc`; anything that is not a hex colour → null. */
export function normalizeHex(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  if (!HEX_RE.test(t)) return null;
  const h = t.slice(1).toLowerCase();
  return `#${h.length === 3 ? h.split('').map((c) => c + c).join('') : h}`;
}

function rgbOf(hex: string): [number, number, number] {
  const h = (normalizeHex(hex) ?? '#000000').slice(1);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

function hexOf(rgb: [number, number, number]): string {
  return `#${rgb.map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('')}`;
}

const toLinear = (c: number) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (c: number) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** WCAG 2.x relative luminance of a hex colour. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = rgbOf(hex).map(toLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two hex colours (1…21). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** WCAG 2.2 AA for normal text — what white button text on the 600 shade must clear. */
export const AA_TEXT = 4.5;

// OKLab / OKLCH (Björn Ottosson's matrices). Lightness steps in OKLCH keep the
// hue of the source colour across the whole ramp, which a plain RGB mix does not.
type Lch = { L: number; C: number; h: number };

function hexToOklch(hex: string): Lch {
  const [r, g, b] = rgbOf(hex).map(toLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { L, C: Math.hypot(A, B), h: Math.atan2(B, A) };
}

/** OKLCH → linear sRGB, or null when the colour falls outside the sRGB gamut. */
function oklchToRgb({ L, C, h }: Lch): [number, number, number] | null {
  const A = C * Math.cos(h);
  const B = C * Math.sin(h);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  const eps = 1e-4;
  if (lin.some((c) => c < -eps || c > 1 + eps)) return null;
  return lin.map((c) => fromLinear(Math.min(1, Math.max(0, c)))) as [number, number, number];
}

/** The nearest in-gamut colour at this lightness and hue: chroma is reduced until it fits. */
function oklchToHex(lch: Lch): string {
  const direct = oklchToRgb(lch);
  if (direct) return hexOf(direct);
  let lo = 0;
  let hi = lch.C;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (oklchToRgb({ ...lch, C: mid })) lo = mid;
    else hi = mid;
  }
  return hexOf(oklchToRgb({ ...lch, C: lo }) ?? [0, 0, 0]);
}

// ── Palette ──────────────────────────────────────────────────────────────────

/** The ten shades an accent palette carries, in order. */
export const PALETTE_STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900] as const;
const IDX_600 = PALETTE_STEPS.indexOf(600);

/**
 * A stored palette ("#…,#…,…", ten hexes, lightest first) → the list, or null
 * when it is not exactly ten valid hex colours. Spaces around commas are fine.
 */
export function parsePalette(text: string | null | undefined): string[] | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  const parts = text.split(',').map((p) => normalizeHex(p));
  if (parts.length !== PALETTE_STEPS.length || parts.some((p) => p === null)) return null;
  return parts as string[];
}

export function formatPalette(palette: readonly string[]): string {
  return palette.join(',');
}

/**
 * Whether a palette can carry the product's primary controls: white text on
 * its 600 shade (the primary button) must clear AA, and so must the 600 shade
 * as text on white (links, the hero's accent word) — the same number, since
 * contrast is symmetric.
 */
export function paletteIsReadable(palette: readonly string[]): boolean {
  return palette.length === PALETTE_STEPS.length && contrastRatio(palette[IDX_600], '#ffffff') >= AA_TEXT;
}

// Target OKLCH lightness per step and the share of the source chroma it keeps,
// shaped after the Tailwind ramps the built-in accents use (pale tints carry
// little colour, the 500–600 core carries all of it, the deep end tapers).
const RAMP_L = [0.971, 0.936, 0.885, 0.808, 0.707, 0.623, 0.546, 0.488, 0.424, 0.379];
const RAMP_C = [0.12, 0.25, 0.45, 0.7, 0.9, 1, 1, 0.92, 0.8, 0.66];

/**
 * A ten-step ramp generated from one brand colour, for an organization that set
 * a colour but no exact palette. Hue is kept, lightness follows the steps above,
 * chroma is clipped into sRGB — and the 600 shade (with everything darker) is
 * pushed down until white text on it clears AA, so a pale brand colour can
 * never produce an unreadable primary button.
 */
export function rampFrom(hex: string): string[] {
  const src = hexToOklch(normalizeHex(hex) ?? '#2563eb');
  const lightness = [...RAMP_L];
  const build = () => lightness.map((L, i) => oklchToHex({ L, C: src.C * RAMP_C[i], h: src.h }));
  let ramp = build();
  for (let guard = 0; guard < 60 && contrastRatio(ramp[IDX_600], '#ffffff') < AA_TEXT; guard++) {
    for (let i = IDX_600; i < lightness.length; i++) lightness[i] = Math.max(0.05, lightness[i] - 0.01);
    ramp = build();
  }
  return ramp;
}

/** The dark-mode translucent forms of the softest box, from the 900 shade (globals.css's pattern). */
export function paletteTint(palette: readonly string[]): { tint: string; tintHover: string } {
  const [r, g, b] = rgbOf(palette[palette.length - 1]);
  return { tint: `rgba(${r},${g},${b},0.25)`, tintHover: `rgba(${r},${g},${b},0.35)` };
}

/**
 * The CSS custom properties the root layout writes on <html> for an
 * organization palette. Every value is a normalized hex or an rgba() built from
 * one, so nothing a tenant typed reaches the style attribute verbatim.
 */
export function paletteCssVars(palette: readonly string[]): Record<string, string> {
  const vars: Record<string, string> = {};
  PALETTE_STEPS.forEach((step, i) => {
    vars[`--brand-${step}`] = normalizeHex(palette[i]) ?? '#000000';
  });
  const { tint, tintHover } = paletteTint(palette);
  vars['--brand-tint'] = tint;
  vars['--brand-tint-hover'] = tintHover;
  return vars;
}

// ── Source decision ──────────────────────────────────────────────────────────

/** Does the row carry any brand field at all? A row with none is the vertical default. */
export function hasAnyBrand(org: Partial<OrgBrandRow> | null | undefined): boolean {
  if (!org) return false;
  return [org.brandName, org.brandColor, org.brandTileColor, org.brandAccent, org.brandPalette, org.brandMarkVersion].some(
    (v) => clean(v) !== null,
  );
}

/**
 * Signed out: does the host's mapped organization supply the brand? Only when
 * it is the product the host serves AND it carries brand data. Mirrors
 * decidePublicInquiryTarget (src/lib/publicHostRule.ts): a mapping that crosses
 * products is a configuration error, and it falls back to the default rather
 * than showing one product's tenant on the other product's door.
 */
export function hostBrandSource(input: {
  hostVertical: BrandVertical;
  mapped: (Partial<OrgBrandRow> & { vertical: BrandVertical }) | null;
}): BrandSource {
  const { hostVertical, mapped } = input;
  return mapped && mapped.vertical === hostVertical && hasAnyBrand(mapped) ? 'org' : 'default';
}

// ── Resolution ───────────────────────────────────────────────────────────────

/** The brand of `org`, every field falling back to `defaults` on its own. */
export function resolveBrandFields(
  org: OrgBrandRow | null,
  defaults: BrandDefaults,
  isAccentKey: (value: unknown) => boolean,
): ResolvedBrandFields {
  if (!org || !hasAnyBrand(org)) {
    return {
      source: 'default',
      productName: defaults.productName,
      themeColor: defaults.themeColor,
      tileColor: defaults.themeColor,
      accent: defaults.accent,
      palette: null,
      markVersion: null,
    };
  }
  const color = normalizeHex(org.brandColor);
  const wantsBrandAccent = org.brandAccent === BRAND_ACCENT;
  const palette = parsePalette(org.brandPalette) ?? (wantsBrandAccent && color ? rampFrom(color) : null);
  let accent = defaults.accent;
  if (wantsBrandAccent) accent = palette ? BRAND_ACCENT : defaults.accent;
  else if (isAccentKey(org.brandAccent)) accent = org.brandAccent as string;
  return {
    source: 'org',
    productName: clean(org.brandName) ?? defaults.productName,
    themeColor: color ?? defaults.themeColor,
    tileColor: normalizeHex(org.brandTileColor) ?? color ?? defaults.themeColor,
    accent,
    palette,
    markVersion: isBrandVersion(org.brandMarkVersion) ? org.brandMarkVersion : null,
  };
}

/**
 * The tile colour a NEW icon set is rendered on: the organization's tile, else
 * its brand colour, else the fallback the caller supplies (the vertical's tint).
 * Part of the version hash, so changing it means re-rendering the set.
 */
export function effectiveTileColor(
  org: Pick<OrgBrandRow, 'brandTileColor' | 'brandColor'> | null,
  fallback: string,
): string {
  return normalizeHex(org?.brandTileColor) ?? normalizeHex(org?.brandColor) ?? normalizeHex(fallback) ?? '#1d4ed8';
}

/**
 * The accent to paint for a person's stored preference under a brand: an
 * explicit accent key wins; 'brand' wins only while the brand has a palette (a
 * person who picked the organization colour and then moved to an organization
 * without one gets the default, never a blank palette); anything else is the
 * brand's default.
 */
export function resolveAccentChoice(
  preference: string | null | undefined,
  brand: { accent: string; palette: readonly string[] | null },
  isAccentKey: (value: unknown) => boolean,
): string {
  if (preference === BRAND_ACCENT) return brand.palette ? BRAND_ACCENT : brand.accent;
  if (isAccentKey(preference)) return preference as string;
  return brand.accent;
}

// ── Generated assets ─────────────────────────────────────────────────────────

/**
 * The kinds of a generated set that are SERVED. `source` (the uploaded
 * original) is stored next to them so the set can be re-rendered, and is never
 * in this list — the public route answers only what is.
 */
export const BRAND_SERVED_KINDS = [
  'mark-128',
  'icon-192',
  'icon-512',
  'icon-512-maskable',
  'apple-touch-icon',
  'favicon-32',
  'shortcut-messages-96',
  'shortcut-todos-96',
  'shortcut-notifications-96',
] as const;

/** The stored original. Never served. */
export const BRAND_SOURCE_KIND = 'source';

/** The kind of one iOS launch image, by its pixel size. */
export function splashKind(w: number, h: number): string {
  return `splash-${w}x${h}`;
}

const SPLASH_KIND_RE = /^splash-\d{3,4}x\d{3,4}$/;

/**
 * The public file name → the kind it serves, or null for anything outside the
 * allowlist (the source, a path, a different extension, a made-up kind).
 */
export function brandKindForFile(file: string): string | null {
  if (typeof file !== 'string' || !file.endsWith('.png')) return null;
  const kind = file.slice(0, -'.png'.length);
  if ((BRAND_SERVED_KINDS as readonly string[]).includes(kind)) return kind;
  return SPLASH_KIND_RE.test(kind) ? kind : null;
}

const VERSION_RE = /^[0-9a-f]{16}$/;

/** A generated set's version: 16 lowercase hex characters, carrying no organization id. */
export function isBrandVersion(value: unknown): value is string {
  return typeof value === 'string' && VERSION_RE.test(value);
}

/** The public URL directory of a set. */
export function brandAssetBase(version: string): string {
  return `/brand/${version}`;
}

/** The public URL of one served file of a set. */
export function brandAssetPath(version: string, kind: string): string {
  return `${brandAssetBase(version)}/${kind}.png`;
}
