// The admin-form versioning rule (#1800) — pure and client-safe, so the
// builder (#1802) can tell an admin "this edit becomes version 3" and refuse a
// re-typed key before the server does, with the same words.
//
//   • A DRAFT version is edited in place.
//   • A PUBLISHED version is never edited in place: the edit becomes version
//     N+1, a draft, which goes live only when it is published.
//   • Within a form (all versions of one key), once any version has been
//     published a field key's TYPE is fixed — every answer ever given to that
//     key must still parse as that type. Re-typing is a 409 `field_type_locked`.
//   • A field that exists in the version being edited keeps its key: sending
//     the same field id with another key is a 409 `field_key_locked` (that is a
//     new field; send it without the id).
//   • A free-text field can never be `matchable` — 400 `not_matchable`.

import { canBeMatchable, isFormFieldType, type FormFieldType } from '@/lib/forms/schema';

export const FORM_AUDIENCES = ['MENTEE', 'MENTOR', 'BOTH'] as const;
export type FormAudience = (typeof FORM_AUDIENCES)[number];

export const FORM_SURFACES = ['REGISTRATION', 'ONBOARDING', 'PROFILE', 'MENTORSHIP_REQUEST'] as const;
export type FormSurface = (typeof FORM_SURFACES)[number];

/** A form key and a field key: lower snake case, starting with a letter. */
export const FORM_KEY_RE = /^[a-z][a-z0-9_]{0,79}$/;

export const MAX_FORM_FIELDS = 40;

export type FormEditCode = 'field_type_locked' | 'field_key_locked' | 'not_matchable' | 'duplicate_key' | 'invalid_type';

export interface IncomingField {
  /** The id of the field in the version being edited, when it is that field. */
  id?: string | null;
  key: string;
  type: string;
  matchable?: boolean;
}

/**
 * Whether an edit may be saved. `lockedTypes` is key → type for every field of
 * every PUBLISHED version of this form; `current` is id → { key, type } for the
 * fields of the version being edited. Returns the refusal, or null.
 */
export function checkFieldEdit(
  incoming: readonly IncomingField[],
  lockedTypes: ReadonlyMap<string, string>,
  current: ReadonlyMap<string, { key: string; type: string }>,
): { code: FormEditCode; key: string } | null {
  const seen = new Set<string>();
  for (const f of incoming) {
    if (seen.has(f.key)) return { code: 'duplicate_key', key: f.key };
    seen.add(f.key);
    if (!isFormFieldType(f.type)) return { code: 'invalid_type', key: f.key };
    if (f.matchable && !canBeMatchable({ type: f.type as FormFieldType })) return { code: 'not_matchable', key: f.key };
    const prior = f.id ? current.get(f.id) : undefined;
    if (prior && (prior.key !== f.key || prior.type !== f.type)) return { code: prior.key !== f.key ? 'field_key_locked' : 'field_type_locked', key: f.key };
    const locked = lockedTypes.get(f.key);
    if (locked && locked !== f.type) return { code: 'field_type_locked', key: f.key };
  }
  return null;
}

/** Where an edit of `version` lands: in place while it is a draft, else a new version. */
export function editTarget(version: { version: number; publishedAt: Date | string | null }, latestVersion: number): { inPlace: true } | { inPlace: false; version: number } {
  if (!version.publishedAt) return { inPlace: true };
  return { inPlace: false, version: latestVersion + 1 };
}

/** The live version of a form: the newest published one that is not archived. */
export function liveVersion<T extends { version: number; publishedAt: Date | string | null; archivedAt: Date | string | null }>(versions: readonly T[]): T | null {
  let best: T | null = null;
  for (const v of versions) if (v.publishedAt && !v.archivedAt && (!best || v.version > best.version)) best = v;
  return best;
}

/**
 * The latest answer per field key across every version of a form, so an
 * answer given to v1 still resolves under v2. `rows` may come in any order.
 */
export function latestAnswersByKey<T extends { fieldKey: string; updatedAt: Date }>(rows: readonly T[]): Map<string, T> {
  const out = new Map<string, T>();
  for (const r of rows) {
    const prev = out.get(r.fieldKey);
    if (!prev || r.updatedAt.getTime() > prev.updatedAt.getTime()) out.set(r.fieldKey, r);
  }
  return out;
}

// ── The builder (#1802) ──────────────────────────────────────────────────────

export const FORM_LOCALES = ['en', 'tr', 'de'] as const;

type Localized = { en?: string; tr?: string; de?: string } | null | undefined;
const filled = (t: Localized, l: (typeof FORM_LOCALES)[number]) => !!t && typeof t[l] === 'string' && t[l]!.trim().length > 0;

/**
 * The locales a field still lacks before it may be published: its label and,
 * for a choice field, every option's label, in all three languages. A
 * participant must never meet a question — or an answer — in a language the
 * programme did not write. Archived fields are not asked, so they do not count.
 */
export function missingLocales(field: { labels: unknown; options?: unknown; archivedAt?: unknown }): (typeof FORM_LOCALES)[number][] {
  if (field.archivedAt) return [];
  const labels = field.labels as Localized;
  const options = Array.isArray(field.options) ? (field.options as { labels?: Localized }[]) : [];
  return FORM_LOCALES.filter((l) => !filled(labels, l) || options.some((o) => !filled(o.labels, l)));
}

// Words that make a question a likely proxy for a protected characteristic
// (AGG § 1 / GDPR art. 9 territory): age, ethnicity, religion, disability,
// gender, marital status, nationality — in the three languages admins write in.
// A WARNING, never a block: some programmes ask these on purpose (a
// scholarship for a group), but they must not become a hard matching rule.
const PROTECTED_PROXY_WORDS = [
  'age', 'birth', 'born', 'ethnic', 'race', 'religio', 'faith', 'disab', 'gender', 'sex', 'marital', 'married', 'nationality', 'citizenship',
  'yaş', 'doğum', 'etnik', 'ırk', 'din', 'inanç', 'engel', 'cinsiyet', 'medeni', 'evli', 'uyruk', 'vatandaş',
  'alter', 'geburt', 'ethni', 'herkunft', 'religion', 'glaube', 'behinder', 'geschlecht', 'familienstand', 'verheiratet', 'staatsangeh', 'nationalität',
];

/** Whether a field's key or any of its labels reads like a protected-characteristic proxy. */
export function looksLikeProtectedProxy(field: { key: string; labels?: unknown }): boolean {
  const labels = (field.labels ?? {}) as Record<string, unknown>;
  const text = [field.key.replace(/_/g, ' '), ...Object.values(labels).filter((v): v is string => typeof v === 'string')].join(' ').toLocaleLowerCase('tr');
  const words = text.split(/[^\p{L}]+/u).filter(Boolean);
  return PROTECTED_PROXY_WORDS.some((w) => words.some((word) => (w.length <= 3 ? word === w : word.startsWith(w))));
}

export interface FormVersionDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

/** What a draft changes against the published version, by field key. */
export function diffFormVersions(
  published: readonly { key: string; type: string; labels: unknown; helpText?: unknown; options?: unknown; required: boolean; matchable: boolean; archivedAt?: unknown }[],
  draft: readonly { key: string; type: string; labels: unknown; helpText?: unknown; options?: unknown; required: boolean; matchable: boolean; archivedAt?: unknown }[],
): FormVersionDiff {
  const live = (fs: typeof published) => new Map(fs.filter((f) => !f.archivedAt).map((f) => [f.key, f]));
  const a = live(published);
  const b = live(draft);
  const sig = (f: (typeof published)[number]) => JSON.stringify([f.type, f.labels, f.helpText ?? null, f.options ?? null, f.required, f.matchable]);
  return {
    added: [...b.keys()].filter((k) => !a.has(k)),
    removed: [...a.keys()].filter((k) => !b.has(k)),
    changed: [...b.keys()].filter((k) => a.has(k) && sig(a.get(k)!) !== sig(b.get(k)!)),
  };
}
