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
