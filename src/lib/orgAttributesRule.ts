// Org-defined segmentation attributes (#1920) — the dependency-free rules:
// the vocabularies, the key shape, how a raw value (typed in the admin screen
// or read from an import cell) is normalised per type, the label in a reader's
// language, and the DERIVED tenure buckets. Pure on purpose: the route, the
// import and the report registry all read it, and scripts/test/org-attributes
// .test.mjs pins it. docs/analytics.md § Dimensions is the prose.
//
// WHAT IS DELIBERATELY NOT HERE: presets. There is no list of suggested
// attributes — above all no special-category one (ethnicity, disability,
// gender, health, religion). A generic attribute an admin defines is the
// customer's choice; a preset we ship would be our recommendation, and storing
// special-category data needs separated storage and its own access control —
// a decision that has not been made (docs/analytics.md).

export const ATTRIBUTE_TYPES = ['SELECT', 'TEXT', 'DATE', 'NUMBER'] as const;
export type AttributeType = (typeof ATTRIBUTE_TYPES)[number];

/** USER today. RELATION is reserved for a later slice and refused on write. */
export const ATTRIBUTE_TARGETS = ['USER'] as const;
export type AttributeTarget = (typeof ATTRIBUTE_TARGETS)[number];

export const MAX_ATTRIBUTES_PER_ORG = 50;
export const MAX_OPTIONS = 100;
/** UserAttributeValue.value and every label are VARCHAR(191). */
export const MAX_VALUE_LENGTH = 191;
export const MAX_LABEL_LENGTH = 191;

const KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;

export function isAttributeType(v: unknown): v is AttributeType {
  return typeof v === 'string' && (ATTRIBUTE_TYPES as readonly string[]).includes(v);
}

export function isAttributeTarget(v: unknown): v is AttributeTarget {
  return typeof v === 'string' && (ATTRIBUTE_TARGETS as readonly string[]).includes(v);
}

export function isAttributeKey(v: unknown): v is string {
  return typeof v === 'string' && KEY_RE.test(v);
}

/**
 * A key derived from a label when the admin did not type one: lower-case
 * ASCII, umlauts and Turkish letters folded, runs of anything else become one
 * underscore. Null when nothing usable is left (the admin must type a key).
 */
export function keyFromLabel(label: string): string | null {
  const folded = label
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/ı/g, 'i')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^[0-9_]+/, '')
    .slice(0, 64)
    .replace(/_+$/, '');
  return isAttributeKey(folded) ? folded : null;
}

/** A SELECT's options as stored: trimmed, non-empty, unique (case-insensitive), capped. */
export function normalizeOptions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const v = item.trim().slice(0, MAX_VALUE_LENGTH);
    if (!v || seen.has(v.toLocaleLowerCase('en'))) continue;
    seen.add(v.toLocaleLowerCase('en'));
    out.push(v);
    if (out.length >= MAX_OPTIONS) break;
  }
  return out;
}

export type ValueResult = { ok: true; value: string } | { ok: false; code: 'empty' | 'too_long' | 'not_an_option' | 'not_a_date' | 'not_a_number' };

/**
 * Normalise one raw value for an attribute. A SELECT value must match an
 * option (case-insensitively; the option's own spelling is stored); a DATE is
 * stored as YYYY-MM-DD (ISO or DD.MM.YYYY accepted — the German Excel export);
 * a NUMBER is stored in its plain decimal form (a decimal comma is accepted).
 */
export function normalizeValue(attr: { type: string; options?: unknown }, raw: unknown): ValueResult {
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  if (!text) return { ok: false, code: 'empty' };
  if (text.length > MAX_VALUE_LENGTH) return { ok: false, code: 'too_long' };
  switch (attr.type) {
    case 'SELECT': {
      const match = normalizeOptions(attr.options).find((o) => o.toLocaleLowerCase('en') === text.toLocaleLowerCase('en'));
      return match ? { ok: true, value: match } : { ok: false, code: 'not_an_option' };
    }
    case 'DATE': {
      const iso = parseDate(text);
      return iso ? { ok: true, value: iso } : { ok: false, code: 'not_a_date' };
    }
    case 'NUMBER': {
      const normalized = text.replace(/\s/g, '').replace(/,(?=\d+$)/, '.');
      if (!/^-?\d+(\.\d+)?$/.test(normalized)) return { ok: false, code: 'not_a_number' };
      return { ok: true, value: String(Number(normalized)) };
    }
    default:
      return { ok: true, value: text };
  }
}

function parseDate(text: string): string | null {
  let y: number, m: number, d: number;
  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match) [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else if ((match = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(text))) [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

/** The admin's own label in the reader's language, falling back EN → TR → DE → key. */
export function attributeLabel(attr: { key: string; labelEn?: string | null; labelTr?: string | null; labelDe?: string | null }, locale: string): string {
  const byLocale: Record<string, string | null | undefined> = { en: attr.labelEn, tr: attr.labelTr, de: attr.labelDe };
  return byLocale[locale]?.trim() || attr.labelEn?.trim() || attr.labelTr?.trim() || attr.labelDe?.trim() || attr.key;
}

// ── Tenure: derived, never stored ────────────────────────────────────────────
// A stored tenure is wrong the day after it is written. A DATE attribute (a
// start date) is bucketed at read time against `now`; the buckets are fixed
// so a segment's name means the same thing in every report and every month.

export const TENURE_BUCKETS = ['lt1y', '1to3y', '3to5y', 'gte5y'] as const;
export type TenureBucket = (typeof TENURE_BUCKETS)[number];

/** The tenure bucket of a stored YYYY-MM-DD start date, or null for a future/invalid date. */
export function tenureBucket(startIso: string, now: Date): TenureBucket | null {
  const start = parseDate(startIso);
  if (!start) return null;
  const s = new Date(`${start}T00:00:00Z`);
  if (s.getTime() > now.getTime()) return null;
  let years = now.getUTCFullYear() - s.getUTCFullYear();
  if (now.getUTCMonth() < s.getUTCMonth() || (now.getUTCMonth() === s.getUTCMonth() && now.getUTCDate() < s.getUTCDate())) years -= 1;
  if (years < 1) return 'lt1y';
  if (years < 3) return '1to3y';
  if (years < 5) return '3to5y';
  return 'gte5y';
}
