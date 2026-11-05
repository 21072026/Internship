// The public partner-programme page's content (docs/affiliate-module.md, #3359) —
// pure and dependency-free (scripts/test/affiliate-landing-rule.test.mjs).
//
// Everything the page says that is specific to one organisation is DATA, stored
// in AffiliateProgramSettings.landing and edited on /admin/affiliates/settings:
// the copy per locale, the contact phone and e-mail, and the address of the
// product's own sign-up page. The page itself only carries generic labels from
// the dictionary, so no tenant's wording, brand or phone number enters the code.
//
// Copy is plain text: the page renders it as text nodes, never as HTML. Every
// field is optional; an empty one falls back field by field (landingCopyFor), so
// a programme can start with one locale and translate later.
//
// A stored value is compared in a fixed key order (canonicalLanding): a JSON
// column does not keep key order (MySQL 8 stores keys sorted), so comparing the
// serialized objects would call an unchanged save "changed" and audit it.

export const LANDING_LOCALES = ['en', 'tr', 'de'] as const;
export type LandingLocale = (typeof LANDING_LOCALES)[number];

/** Single-line texts: titles and button labels. */
export const LANDING_TEXT_FIELDS = [
  'heroTitle',
  'heroSubtitle',
  'applyLabel',
  'portalLabel',
  'productSignupLabel',
  'tableTitle',
  'tableCtaLabel',
  'stepsTitle',
  'contactTitle',
  'callLabel',
  'ctaTitle',
  'ctaApplyLabel',
  'ctaContactLabel',
] as const;
/** Paragraphs. */
export const LANDING_PARAGRAPH_FIELDS = ['intro', 'contactText', 'ctaText'] as const;

export type LandingTextField = (typeof LANDING_TEXT_FIELDS)[number];
export type LandingParagraphField = (typeof LANDING_PARAGRAPH_FIELDS)[number];

export const LANDING_LIMITS = {
  text: 160,
  paragraph: 1_000,
  steps: 6,
  stepTitle: 80,
  stepText: 300,
  bullets: 6,
  bullet: 160,
  email: 191,
  phone: 30,
  url: 500,
  /** A hand-typed figure on a stat card ("1.200+", "98 %"). */
  statValue: 20,
} as const;

// The three figure cards (#3364). Each is `live` (counted from the programme,
// through the overview's own query), `manual` (a figure the admin types and
// answers for) or `hidden`. Satisfaction has no source in the product, so it
// can only be typed or hidden — `live` there is refused, never faked. A live
// card disappears while the programme is smaller than STAT_LIVE_MIN_PARTNERS:
// "3 active partners" advertises the opposite of what the card is for.
export const LANDING_STAT_KEYS = ['activePartners', 'customers', 'satisfaction'] as const;
export type LandingStatKey = (typeof LANDING_STAT_KEYS)[number];
export const STAT_MODES = ['live', 'manual', 'hidden'] as const;
export type StatMode = (typeof STAT_MODES)[number];
/** The keys that have a live source; the rest are `manual` or `hidden` only. */
export const LIVE_STAT_KEYS: readonly LandingStatKey[] = ['activePartners', 'customers'];
export const STAT_LIVE_MIN_PARTNERS = 10;

export interface LandingStat {
  mode: StatMode;
  /** The typed figure, only for `manual`. */
  value: string | null;
}

export interface LandingStep {
  title: string;
  text: string;
}

export type LandingCopy = Partial<Record<LandingTextField | LandingParagraphField, string>> & {
  steps?: LandingStep[];
  bullets?: string[];
};

export interface Landing {
  copy: Partial<Record<LandingLocale, LandingCopy>>;
  /** As typed, normalised (trimmed, inner whitespace collapsed). */
  phone: string | null;
  email: string | null;
  /** https: the product's own sign-up page ("open an account" button). */
  productSignupUrl: string | null;
  /** The figure cards; a key that is absent reads as `hidden`. */
  stats: Partial<Record<LandingStatKey, LandingStat>>;
  /** The page's look (#3535); null = the page as it always was (host brand colours). */
  theme: LandingTheme | null;
}

export type LandingIssueCode = 'type' | 'locale' | 'unknown' | 'too_long' | 'too_many' | 'invalid' | 'not_https' | 'contrast';
export interface LandingIssue {
  /** A dotted path into the input, e.g. `copy.de.heroTitle`, `copy.en.steps.2.title`, `phone`. */
  field: string;
  code: LandingIssueCode;
}

export type LandingParseResult = { ok: true; landing: Landing } | { ok: false; issues: LandingIssue[] };

export const EMPTY_LANDING: Landing = { copy: {}, phone: null, email: null, productSignupUrl: null, stats: {}, theme: null };

const isLocale = (v: string): v is LandingLocale => (LANDING_LOCALES as readonly string[]).includes(v);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Line endings normalised and the text trimmed; null for "nothing there". */
function cleanText(v: string, multiline: boolean): string | null {
  const s = multiline ? v.replace(/\r\n?/g, '\n').trim() : v.replace(/\s+/g, ' ').trim();
  return s === '' ? null : s;
}

/**
 * A phone number as a person writes it: digits with + ( ) - / . and spaces, at
 * least five digits, a leading + only. Returned normalised for display;
 * telHref() makes the link.
 */
export function parsePhone(raw: string): string | null {
  const s = raw.replace(/\s+/g, ' ').trim();
  if (s.length > LANDING_LIMITS.phone) return null;
  if (!/^\+?[0-9 ()\-/.]+$/.test(s)) return null;
  if ((s.match(/[0-9]/g) ?? []).length < 5) return null;
  return s;
}

/** The `tel:` link for a stored phone: the digits, with the leading + kept. */
export function telHref(phone: string): string {
  return `tel:${phone.startsWith('+') ? '+' : ''}${phone.replace(/[^0-9]/g, '')}`;
}

/** Deliberately simple: one @, a dot in the domain, no spaces. The mail client is the judge. */
export function parseEmail(raw: string): string | null {
  const s = raw.trim();
  if (s.length > LANDING_LIMITS.email) return null;
  return /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>".]+$/.test(s) ? s : null;
}

/** https only, no credentials, at most LANDING_LIMITS.url long; stored as the URL parser prints it. */
export function parseHttpsUrl(raw: string): { ok: true; url: string } | { ok: false; code: 'invalid' | 'not_https' | 'too_long' } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, code: 'invalid' };
  }
  if (url.protocol !== 'https:') return { ok: false, code: 'not_https' };
  if (url.username || url.password) return { ok: false, code: 'invalid' };
  const printed = url.toString();
  if (printed.length > LANDING_LIMITS.url) return { ok: false, code: 'too_long' };
  return { ok: true, url: printed };
}

function parseCopy(input: unknown, path: string, issues: LandingIssue[]): LandingCopy {
  const copy: LandingCopy = {};
  if (!isObject(input)) {
    issues.push({ field: path, code: 'type' });
    return copy;
  }
  const text = (key: string, value: unknown, max: number, multiline: boolean): string | null => {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string') {
      issues.push({ field: `${path}.${key}`, code: 'type' });
      return null;
    }
    const s = cleanText(value, multiline);
    if (s !== null && s.length > max) {
      issues.push({ field: `${path}.${key}`, code: 'too_long' });
      return null;
    }
    return s;
  };
  for (const [key, value] of Object.entries(input)) {
    if ((LANDING_TEXT_FIELDS as readonly string[]).includes(key)) {
      const s = text(key, value, LANDING_LIMITS.text, false);
      if (s !== null) copy[key as LandingTextField] = s;
    } else if ((LANDING_PARAGRAPH_FIELDS as readonly string[]).includes(key)) {
      const s = text(key, value, LANDING_LIMITS.paragraph, true);
      if (s !== null) copy[key as LandingParagraphField] = s;
    } else if (key === 'steps') {
      if (value === null || value === undefined) continue;
      if (!Array.isArray(value)) {
        issues.push({ field: `${path}.steps`, code: 'type' });
        continue;
      }
      if (value.length > LANDING_LIMITS.steps) issues.push({ field: `${path}.steps`, code: 'too_many' });
      const steps: LandingStep[] = [];
      value.slice(0, LANDING_LIMITS.steps).forEach((step, i) => {
        if (!isObject(step)) {
          issues.push({ field: `${path}.steps.${i}`, code: 'type' });
          return;
        }
        const title = text(`steps.${i}.title`, step.title, LANDING_LIMITS.stepTitle, false);
        const body = text(`steps.${i}.text`, step.text, LANDING_LIMITS.stepText, true);
        // A step with neither half is an empty row of the form, not content.
        if (title !== null || body !== null) steps.push({ title: title ?? '', text: body ?? '' });
      });
      if (steps.length > 0) copy.steps = steps;
    } else if (key === 'bullets') {
      if (value === null || value === undefined) continue;
      if (!Array.isArray(value)) {
        issues.push({ field: `${path}.bullets`, code: 'type' });
        continue;
      }
      if (value.length > LANDING_LIMITS.bullets) issues.push({ field: `${path}.bullets`, code: 'too_many' });
      const bullets = value
        .slice(0, LANDING_LIMITS.bullets)
        .map((b, i) => text(`bullets.${i}`, b, LANDING_LIMITS.bullet, false))
        .filter((b): b is string => b !== null);
      if (bullets.length > 0) copy.bullets = bullets;
    } else {
      issues.push({ field: `${path}.${key}`, code: 'unknown' });
    }
  }
  return copy;
}

/** Validates untrusted landing content (a request body). Every problem at once. */
export function parseLanding(input: unknown): LandingParseResult {
  const issues: LandingIssue[] = [];
  if (!isObject(input)) return { ok: false, issues: [{ field: '*', code: 'type' }] };
  const landing: Landing = { copy: {}, phone: null, email: null, productSignupUrl: null, stats: {}, theme: null };

  for (const key of Object.keys(input)) {
    if (!['copy', 'phone', 'email', 'productSignupUrl', 'stats', 'theme'].includes(key)) issues.push({ field: key, code: 'unknown' });
  }

  const copy = input.copy;
  if (copy !== undefined && copy !== null) {
    if (!isObject(copy)) issues.push({ field: 'copy', code: 'type' });
    else {
      for (const [locale, value] of Object.entries(copy)) {
        if (!isLocale(locale)) {
          issues.push({ field: `copy.${locale}`, code: 'locale' });
          continue;
        }
        if (value === null || value === undefined) continue;
        const parsed = parseCopy(value, `copy.${locale}`, issues);
        if (Object.keys(parsed).length > 0) landing.copy[locale] = parsed;
      }
    }
  }

  const optionalString = (key: 'phone' | 'email' | 'productSignupUrl'): string | null => {
    const v = input[key];
    if (v === null || v === undefined) return null;
    if (typeof v !== 'string') {
      issues.push({ field: key, code: 'type' });
      return null;
    }
    return v.trim() === '' ? null : v;
  };

  const phone = optionalString('phone');
  if (phone !== null) {
    landing.phone = parsePhone(phone);
    if (landing.phone === null) issues.push({ field: 'phone', code: phone.trim().length > LANDING_LIMITS.phone ? 'too_long' : 'invalid' });
  }
  const email = optionalString('email');
  if (email !== null) {
    landing.email = parseEmail(email);
    if (landing.email === null) issues.push({ field: 'email', code: email.trim().length > LANDING_LIMITS.email ? 'too_long' : 'invalid' });
  }
  const url = optionalString('productSignupUrl');
  if (url !== null) {
    const parsed = parseHttpsUrl(url);
    if (parsed.ok) landing.productSignupUrl = parsed.url;
    else issues.push({ field: 'productSignupUrl', code: parsed.code });
  }

  const stats = input.stats;
  if (stats !== undefined && stats !== null) {
    if (!isObject(stats)) issues.push({ field: 'stats', code: 'type' });
    else landing.stats = parseStats(stats, issues);
  }

  if (input.theme !== undefined && input.theme !== null) landing.theme = parseTheme(input.theme, issues);

  return issues.length > 0 ? { ok: false, issues } : { ok: true, landing };
}

function parseStats(input: Record<string, unknown>, issues: LandingIssue[]): Partial<Record<LandingStatKey, LandingStat>> {
  const out: Partial<Record<LandingStatKey, LandingStat>> = {};
  for (const [key, raw] of Object.entries(input)) {
    const path = `stats.${key}`;
    if (!(LANDING_STAT_KEYS as readonly string[]).includes(key)) {
      issues.push({ field: path, code: 'unknown' });
      continue;
    }
    if (raw === null || raw === undefined) continue;
    if (!isObject(raw) || typeof raw.mode !== 'string' || !(STAT_MODES as readonly string[]).includes(raw.mode)) {
      issues.push({ field: `${path}.mode`, code: 'invalid' });
      continue;
    }
    const statKey = key as LandingStatKey;
    const mode = raw.mode as StatMode;
    if (mode === 'live' && !LIVE_STAT_KEYS.includes(statKey)) {
      issues.push({ field: `${path}.mode`, code: 'invalid' });
      continue;
    }
    if (mode !== 'manual') {
      out[statKey] = { mode, value: null };
      continue;
    }
    if (raw.value !== null && raw.value !== undefined && typeof raw.value !== 'string') {
      issues.push({ field: `${path}.value`, code: 'type' });
      continue;
    }
    const value = typeof raw.value === 'string' ? cleanText(raw.value, false) : null;
    if (value === null) {
      // A typed card with nothing typed would render an empty box.
      issues.push({ field: `${path}.value`, code: 'invalid' });
      continue;
    }
    if (value.length > LANDING_LIMITS.statValue) {
      issues.push({ field: `${path}.value`, code: 'too_long' });
      continue;
    }
    out[statKey] = { mode, value };
  }
  return out;
}

/** The live counts a page may show (from affiliateOverview), or null when unknown. */
export interface LiveStatCounts {
  activePartners: number;
  customers: number;
}

export interface StatCard {
  key: LandingStatKey;
  value: string;
}

/**
 * The cards a visitor sees, in a fixed order. `hidden` (or absent) shows
 * nothing; `manual` shows the typed figure; `live` shows the count — unless the
 * counts are unknown or the programme has fewer than STAT_LIVE_MIN_PARTNERS
 * active partners, in which case every live card is left out.
 */
export function statCards(landing: Landing, live: LiveStatCounts | null, formatCount: (n: number) => string = String): StatCard[] {
  const liveShown = live !== null && live.activePartners >= STAT_LIVE_MIN_PARTNERS;
  const cards: StatCard[] = [];
  for (const key of LANDING_STAT_KEYS) {
    const stat = landing.stats[key];
    if (!stat || stat.mode === 'hidden') continue;
    if (stat.mode === 'manual' && stat.value) cards.push({ key, value: stat.value });
    if (stat.mode === 'live' && liveShown && LIVE_STAT_KEYS.includes(key)) {
      cards.push({ key, value: formatCount(live[key as keyof LiveStatCounts]) });
    }
  }
  return cards;
}

/** True when any card asks for a live count — the page reads the counts only then. */
export function needsLiveStats(landing: Landing): boolean {
  return LANDING_STAT_KEYS.some((k) => landing.stats[k]?.mode === 'live');
}

/** A stored value (JSON column), read defensively: anything malformed reads as empty. */
export function readStoredLanding(stored: unknown): Landing {
  if (stored === null || stored === undefined) return EMPTY_LANDING;
  const parsed = parseLanding(stored);
  return parsed.ok ? parsed.landing : EMPTY_LANDING;
}

/** The landing as one string with a fixed key order — the shape that is compared. */
export function canonicalLanding(landing: Landing): string {
  const copy = LANDING_LOCALES.filter((l) => landing.copy[l]).map((l) => {
    const c = landing.copy[l] as LandingCopy;
    return [
      l,
      LANDING_TEXT_FIELDS.map((f) => c[f] ?? null),
      LANDING_PARAGRAPH_FIELDS.map((f) => c[f] ?? null),
      (c.steps ?? []).map((s) => [s.title, s.text]),
      c.bullets ?? [],
    ];
  });
  const stats = LANDING_STAT_KEYS.map((k) => {
    const st = landing.stats[k];
    return st && st.mode !== 'hidden' ? [st.mode, st.value] : null;
  });
  return JSON.stringify([copy, landing.phone, landing.email, landing.productSignupUrl, stats, canonicalTheme(landing.theme)]);
}

/** True when the landing holds anything a visitor would see. */
export function landingHasContent(landing: Landing): boolean {
  return LANDING_LOCALES.some((l) => landing.copy[l] && Object.keys(landing.copy[l] as LandingCopy).length > 0);
}

/**
 * The copy a visitor reads, FIELD by field: their locale, else English, else the
 * other locales in order — so a half-translated programme shows every field it
 * has rather than an empty section. Steps and bullets are taken as a whole list
 * from the first locale that has any.
 */
export function landingCopyFor(landing: Landing, locale: string): LandingCopy {
  const order: LandingLocale[] = [...new Set<LandingLocale>([...(isLocale(locale) ? [locale] : []), 'en', ...LANDING_LOCALES])];
  const out: LandingCopy = {};
  for (const f of [...LANDING_TEXT_FIELDS, ...LANDING_PARAGRAPH_FIELDS]) {
    for (const l of order) {
      const v = landing.copy[l]?.[f];
      if (v) {
        out[f] = v;
        break;
      }
    }
  }
  for (const l of order) {
    const steps = landing.copy[l]?.steps;
    if (steps?.length) {
      out.steps = steps;
      break;
    }
  }
  for (const l of order) {
    const bullets = landing.copy[l]?.bullets;
    if (bullets?.length) {
      out.bullets = bullets;
      break;
    }
  }
  return out;
}

/** The part of a commission plan the public table shows (structural, so this file stays dependency-free). */
export interface PublicPlanShape {
  currency: string;
  tiers: { upToMinor: number; commissionMinor: number }[];
  topCommissionMinor: number;
  percentBps: number;
  switchAtCustomer: number | null;
  windowMonths: number | null;
}

/**
 * One row of the public commission table: the customer's first payment
 * (`overMinor` < payment ≤ `upToMinor`; null = open-ended) and the one-off
 * commission it earns. Derived from the plan on every render, never typed by
 * hand, so the page cannot disagree with what the engine pays.
 */
export interface CommissionTableRow {
  overMinor: number | null;
  upToMinor: number | null;
  commissionMinor: number;
}

export function commissionTableRows(plan: PublicPlanShape): CommissionTableRow[] {
  const tiers = [...plan.tiers].sort((a, b) => a.upToMinor - b.upToMinor);
  const rows: CommissionTableRow[] = tiers.map((t, i) => ({
    overMinor: i === 0 ? null : tiers[i - 1].upToMinor,
    upToMinor: t.upToMinor,
    commissionMinor: t.commissionMinor,
  }));
  rows.push({ overMinor: tiers.length > 0 ? tiers[tiers.length - 1].upToMinor : null, upToMinor: null, commissionMinor: plan.topCommissionMinor });
  return rows;
}

/** The highest one-off commission the table offers ("up to …"). */
export function maxOneOffCommission(plan: PublicPlanShape): number {
  return Math.max(plan.topCommissionMinor, ...plan.tiers.map((t) => t.commissionMinor));
}

/**
 * A partner code as it may appear after `?ref=` — the same shape as
 * PARTNER_CODE_RE in src/lib/affiliatePartners.ts (kept here because this file
 * stays dependency-free; the unit test pins the two together).
 */
export const REFERRAL_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

/**
 * Where a visitor who arrived through a partner's link (`/partner?ref=<code>`,
 * #3365) is sent: the programme's customer sign-up page with the same code, and
 * nothing else from the request. Null — show the page — when there is no
 * sign-up page or the code is not a code. Whether the code belongs to an active
 * partner is deliberately NOT asked here: the answer would tell a stranger which
 * codes exist, and the link is judged where the account event arrives (#3354).
 */
export function customerSignupRedirect(signupUrl: string | null, ref: unknown): string | null {
  if (!signupUrl || typeof ref !== 'string' || !REFERRAL_CODE_RE.test(ref)) return null;
  let url: URL;
  try {
    url = new URL(signupUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  url.searchParams.set('ref', ref);
  return url.toString();
}

// ── The page's look (#3535) ─────────────────────────────────────────────────
//
// An organisation can make /partner and /partner/apply look like its own site.
// The look is DATA like the copy, and deliberately narrow: six colours as
// #rrggbb, two fonts from FONT_KEYS (self-hosted, never a URL), a handful of
// named layout variants, an entrance animation, and up to three pictures or
// videos that were uploaded to OUR storage — referenced by asset id, so no
// external address, stylesheet or script can enter the page through it.
//
// Contrast is judged here, on save, against WCAG 2.x AA. Body text needs 4.5:1
// against the page and the cards; headings, figures and themed buttons are
// rendered as large text (≥ 24px, or ≥ 19px bold), which needs 3:1. The colour
// of the text on a filled area (a button, the hero's gradient) is never chosen
// by hand: onFill() picks white or black, whichever meets the bar, so a fill
// can only be refused where no text colour could work on it at all. A picture
// or video cannot be measured; text over one sits on a scrim (heroOverlay) or
// carries a shadow, and the editor's preview shows the result.
//
// Not the org's WHITE_LABEL branding (brandColor / brand mark, ENTERPRISE): the
// partner page is a marketing page of the programme, and its look is edited by
// the programme's admin next to its copy.

export const THEME_COLOR_KEYS = ['primary', 'secondary', 'heading', 'text', 'background', 'surface'] as const;
export type ThemeColorKey = (typeof THEME_COLOR_KEYS)[number];

/** The fonts a theme may name; each is self-hosted by next/font (src/app/partner/fonts.ts). */
export const FONT_KEYS = [
  'inter',
  'roboto',
  'open-sans',
  'lato',
  'montserrat',
  'poppins',
  'manrope',
  'nunito',
  'raleway',
  'dm-sans',
  'playfair-display',
  'merriweather',
] as const;
export type FontKey = (typeof FONT_KEYS)[number];

/** Every named option of a theme, with its allowed values; the first is the default. */
export const THEME_OPTIONS = {
  heroAlign: ['center', 'start'],
  heroHeight: ['compact', 'tall'],
  heroOverlay: ['brand', 'dark', 'none'],
  navLayout: ['start', 'center'],
  corners: ['rounded', 'square', 'large'],
  cardStyle: ['shadow', 'outline', 'flat'],
  stepsStyle: ['plain', 'band'],
  ctaStyle: ['band', 'plain'],
  animation: ['none', 'fade', 'rise', 'zoom'],
} as const;
export type ThemeOptionKey = keyof typeof THEME_OPTIONS;
export type ThemeOptions = { [K in ThemeOptionKey]: (typeof THEME_OPTIONS)[K][number] };

/** The media slots: the logo (an image), the hero's background and the picture beside the closing call (image or video). */
export const THEME_MEDIA_SLOTS = ['logo', 'hero', 'showcase'] as const;
export type ThemeMediaSlot = (typeof THEME_MEDIA_SLOTS)[number];
/** Which kinds of upload a slot takes. */
export const THEME_MEDIA_KINDS: Record<ThemeMediaSlot, readonly ('image' | 'video')[]> = {
  logo: ['image'],
  hero: ['image', 'video'],
  showcase: ['image', 'video'],
};

export interface LandingTheme extends ThemeOptions {
  colors: Record<ThemeColorKey, string>;
  headingFont: FontKey;
  bodyFont: FontKey;
  /** Asset ids of AffiliateLandingAsset rows of the same organisation. */
  media: Record<ThemeMediaSlot, string | null>;
}

/** What a new theme starts from in the editor: neutral, and AA-clean. */
export const DEFAULT_THEME: LandingTheme = {
  colors: { primary: '#2563eb', secondary: '#7c3aed', heading: '#111827', text: '#374151', background: '#ffffff', surface: '#f3f4f6' },
  headingFont: 'inter',
  bodyFont: 'inter',
  heroAlign: 'center',
  heroHeight: 'compact',
  heroOverlay: 'brand',
  navLayout: 'start',
  corners: 'rounded',
  cardStyle: 'shadow',
  stepsStyle: 'plain',
  ctaStyle: 'band',
  animation: 'none',
  media: { logo: null, hero: null, showcase: null },
};

/** AA for body text, and for large text (≥ 24px, or ≥ 18.66px bold). */
export const CONTRAST_TEXT = 4.5;
export const CONTRAST_LARGE = 3;

const HEX_RE = /^#[0-9a-f]{6}$/;
/** The shape of an asset id (a cuid): letters and digits only, so it is safe in a URL path. */
export const ASSET_ID_RE = /^[a-z0-9]{20,40}$/;

/** A colour as the theme stores it: `#rrggbb`, lower case; `#rgb` is expanded. Null for anything else. */
export function parseHexColor(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(s)) s = `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  return HEX_RE.test(s) ? s : null;
}

/** WCAG relative luminance of a `#rrggbb` colour. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio of two `#rrggbb` colours (1 … 21). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export const WHITE = '#ffffff';
export const BLACK = '#000000';

/**
 * The text colour for a filled area: white when it reaches `min` on every one
 * of `fills` (a gradient has two), else black when that does, else null — no
 * text colour works there. White is preferred: it is what a brand's own
 * buttons almost always use.
 */
export function onFill(fills: string[], min: number): string | null {
  if (fills.every((f) => contrastRatio(WHITE, f) >= min)) return WHITE;
  if (fills.every((f) => contrastRatio(BLACK, f) >= min)) return BLACK;
  return null;
}

/** The colours a page renders, all derived from a theme that parseTheme accepted. */
export interface ThemePalette extends Record<ThemeColorKey, string> {
  /** Text on a primary / secondary button (large text). */
  onPrimary: string;
  onSecondary: string;
  /** Text on the hero and on a `band` call to action (the primary → secondary gradient). */
  onHero: string;
  onBand: string;
  /** Text on the heading-coloured `band` behind the steps (its title only: large). */
  onHeading: string;
  /** Small accent text on the page (the table's eyebrow): primary when it reaches 4.5:1, else the heading colour. */
  accentText: string;
  /** Large accent text on a card (the figures, the step numbers): primary when it reaches 3:1 there, else the heading colour. */
  accentLarge: string;
}

export function themePalette(theme: LandingTheme): ThemePalette {
  const c = theme.colors;
  return {
    ...c,
    onPrimary: onFill([c.primary], CONTRAST_LARGE) ?? BLACK,
    onSecondary: onFill([c.secondary], CONTRAST_LARGE) ?? BLACK,
    onHero: onFill([c.primary, c.secondary], CONTRAST_LARGE) ?? WHITE,
    onBand: onFill([c.primary, c.secondary], CONTRAST_TEXT) ?? WHITE,
    onHeading: onFill([c.heading], CONTRAST_LARGE) ?? WHITE,
    accentText: contrastRatio(c.primary, c.background) >= CONTRAST_TEXT ? c.primary : c.heading,
    accentLarge: contrastRatio(c.primary, c.surface) >= CONTRAST_LARGE ? c.primary : c.heading,
  };
}

/**
 * The contrast every theme must meet, as issues on the colour to change. Only
 * pairs the page actually renders are judged, so a variant that is not in use
 * (a `plain` call to action, an image hero) asks nothing of its colours.
 */
export function themeContrastIssues(theme: LandingTheme): LandingIssue[] {
  const c = theme.colors;
  const out: LandingIssue[] = [];
  const need = (field: ThemeColorKey, ok: boolean) => {
    if (!ok && !out.some((i) => i.field === `theme.colors.${field}`)) out.push({ field: `theme.colors.${field}`, code: 'contrast' });
  };
  need('text', contrastRatio(c.text, c.background) >= CONTRAST_TEXT);
  need('surface', contrastRatio(c.text, c.surface) >= CONTRAST_TEXT);
  need('heading', contrastRatio(c.heading, c.background) >= CONTRAST_LARGE && contrastRatio(c.heading, c.surface) >= CONTRAST_LARGE);
  // The gradient hero (no picture) carries its title, subtitle and nav on both stops.
  if (!theme.media.hero) need('secondary', onFill([c.primary, c.secondary], CONTRAST_LARGE) !== null);
  // A `band` call to action carries body text and the bullets on the gradient.
  if (theme.ctaStyle === 'band') need('secondary', onFill([c.primary, c.secondary], CONTRAST_TEXT) !== null);
  return out;
}

function parseTheme(input: unknown, issues: LandingIssue[]): LandingTheme | null {
  if (!isObject(input)) {
    issues.push({ field: 'theme', code: 'type' });
    return null;
  }
  const before = issues.length;
  const theme: LandingTheme = { ...DEFAULT_THEME, colors: { ...DEFAULT_THEME.colors }, media: { ...DEFAULT_THEME.media } };
  const optionKeys = Object.keys(THEME_OPTIONS) as ThemeOptionKey[];
  for (const [key, value] of Object.entries(input)) {
    const path = `theme.${key}`;
    if (key === 'colors') {
      if (!isObject(value)) {
        issues.push({ field: path, code: 'type' });
        continue;
      }
      for (const [ck, cv] of Object.entries(value)) {
        if (!(THEME_COLOR_KEYS as readonly string[]).includes(ck)) issues.push({ field: `${path}.${ck}`, code: 'unknown' });
        else if (cv !== null && cv !== undefined) {
          const hex = parseHexColor(cv);
          if (hex) theme.colors[ck as ThemeColorKey] = hex;
          else issues.push({ field: `${path}.${ck}`, code: 'invalid' });
        }
      }
    } else if (key === 'headingFont' || key === 'bodyFont') {
      if (value === null || value === undefined) continue;
      if (typeof value === 'string' && (FONT_KEYS as readonly string[]).includes(value)) theme[key] = value as FontKey;
      else issues.push({ field: path, code: 'invalid' });
    } else if ((optionKeys as string[]).includes(key)) {
      if (value === null || value === undefined) continue;
      const allowed = THEME_OPTIONS[key as ThemeOptionKey] as readonly string[];
      if (typeof value === 'string' && allowed.includes(value)) (theme as unknown as Record<string, string>)[key] = value;
      else issues.push({ field: path, code: 'invalid' });
    } else if (key === 'media') {
      if (!isObject(value)) {
        issues.push({ field: path, code: 'type' });
        continue;
      }
      for (const [slot, id] of Object.entries(value)) {
        if (!(THEME_MEDIA_SLOTS as readonly string[]).includes(slot)) issues.push({ field: `${path}.${slot}`, code: 'unknown' });
        else if (id !== null && id !== undefined && id !== '') {
          // An id, never an address: a URL, a data: URI or a path is refused here.
          if (typeof id === 'string' && ASSET_ID_RE.test(id)) theme.media[slot as ThemeMediaSlot] = id;
          else issues.push({ field: `${path}.${slot}`, code: 'invalid' });
        }
      }
    } else {
      issues.push({ field: path, code: 'unknown' });
    }
  }
  if (issues.length > before) return null;
  issues.push(...themeContrastIssues(theme));
  return issues.length > before ? null : theme;
}

/** The asset ids a theme points at, slot by slot (the save checks they are the org's and of the right kind). */
export function themeMediaRefs(theme: LandingTheme | null): { slot: ThemeMediaSlot; id: string }[] {
  if (!theme) return [];
  return THEME_MEDIA_SLOTS.flatMap((slot) => (theme.media[slot] ? [{ slot, id: theme.media[slot] as string }] : []));
}

function canonicalTheme(theme: LandingTheme | null): unknown {
  if (!theme) return null;
  return [
    THEME_COLOR_KEYS.map((k) => theme.colors[k]),
    theme.headingFont,
    theme.bodyFont,
    (Object.keys(THEME_OPTIONS) as ThemeOptionKey[]).map((k) => theme[k]),
    THEME_MEDIA_SLOTS.map((s) => theme.media[s]),
  ];
}

/**
 * Which parts of the landing a save changes — the audit row's whole detail
 * (field names only, never a value): `copy.<locale>`, `phone`, `email`,
 * `productSignupUrl`, `stats`, `theme` (added or removed) or `theme.colors`,
 * `theme.fonts`, `theme.layout`, `theme.animation`, `theme.media`.
 */
export function changedLandingFields(before: Landing, after: Landing): string[] {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const one = (l: Landing, locale: LandingLocale) => JSON.parse(canonicalLanding({ ...EMPTY_LANDING, copy: { [locale]: l.copy[locale] } }))[0];
  const out: string[] = [];
  for (const l of LANDING_LOCALES) if (!same(one(before, l), one(after, l))) out.push(`copy.${l}`);
  for (const k of ['phone', 'email', 'productSignupUrl'] as const) if (before[k] !== after[k]) out.push(k);
  const stats = (l: Landing) => JSON.parse(canonicalLanding({ ...EMPTY_LANDING, stats: l.stats }))[4];
  if (!same(stats(before), stats(after))) out.push('stats');
  const a = before.theme;
  const b = after.theme;
  if (!a || !b) {
    if (a !== b) out.push('theme');
    return out;
  }
  const layout = (t: LandingTheme) => (Object.keys(THEME_OPTIONS) as ThemeOptionKey[]).filter((k) => k !== 'animation').map((k) => t[k]);
  if (!same(THEME_COLOR_KEYS.map((k) => a.colors[k]), THEME_COLOR_KEYS.map((k) => b.colors[k]))) out.push('theme.colors');
  if (a.headingFont !== b.headingFont || a.bodyFont !== b.bodyFont) out.push('theme.fonts');
  if (!same(layout(a), layout(b))) out.push('theme.layout');
  if (a.animation !== b.animation) out.push('theme.animation');
  if (!same(THEME_MEDIA_SLOTS.map((s) => a.media[s]), THEME_MEDIA_SLOTS.map((s) => b.media[s]))) out.push('theme.media');
  return out;
}

/** The upload rules for a theme's media (the route and the editor's file picker read the same lists). */
export const THEME_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const THEME_VIDEO_TYPES = ['video/mp4', 'video/webm'] as const;
export const THEME_MEDIA_MAX_BYTES = { image: 5 * 1024 * 1024, video: 15 * 1024 * 1024 } as const;
/** At most this many uploads per organisation, referenced or not (unreferenced ones are swept on save). */
export const THEME_MEDIA_MAX_PER_ORG = 30;

/** The kind of a declared upload type, or null when the theme does not take it (no SVG: it can carry script). */
export function themeMediaKind(contentType: string): 'image' | 'video' | null {
  const t = contentType.toLowerCase();
  if ((THEME_IMAGE_TYPES as readonly string[]).includes(t)) return 'image';
  if ((THEME_VIDEO_TYPES as readonly string[]).includes(t)) return 'video';
  return null;
}

/** Where an uploaded theme asset is served (public: the page it decorates is public). */
export function themeMediaUrl(id: string): string {
  return `/api/public/partner-media/${id}`;
}
