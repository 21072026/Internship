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
} as const;

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
}

export type LandingIssueCode = 'type' | 'locale' | 'unknown' | 'too_long' | 'too_many' | 'invalid' | 'not_https';
export interface LandingIssue {
  /** A dotted path into the input, e.g. `copy.de.heroTitle`, `copy.en.steps.2.title`, `phone`. */
  field: string;
  code: LandingIssueCode;
}

export type LandingParseResult = { ok: true; landing: Landing } | { ok: false; issues: LandingIssue[] };

export const EMPTY_LANDING: Landing = { copy: {}, phone: null, email: null, productSignupUrl: null };

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
  const landing: Landing = { copy: {}, phone: null, email: null, productSignupUrl: null };

  for (const key of Object.keys(input)) {
    if (!['copy', 'phone', 'email', 'productSignupUrl'].includes(key)) issues.push({ field: key, code: 'unknown' });
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

  return issues.length > 0 ? { ok: false, issues } : { ok: true, landing };
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
  return JSON.stringify([copy, landing.phone, landing.email, landing.productSignupUrl]);
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
