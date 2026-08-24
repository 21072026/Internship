// Free-form tags on people (#887). Pure and client-safe — both the API and the
// UI validate against the same rules, so a limit cannot be enforced in one and
// silently absent in the other.
//
// Where tags sit next to what already exists, because these three blur without
// a stated boundary:
//   · Cohort — the official period group. Exactly ONE per candidate.
//   · Source — where they came from. Exactly ONE.
//   · Tag    — whatever this organisation needs to mark. MANY per person,
//              invented by the people doing the work.

/**
 * Caps, enforced server-side.
 *
 * Unlimited tagging ends somewhere specific: everyone invents their own label,
 * nobody's label means anything, and the filter becomes noise. These numbers
 * are deliberately generous enough never to block real work and small enough
 * that the vocabulary stays shared.
 */
export const MAX_TAGS_PER_USER = 20;
export const MAX_TAGS_PER_ORG = 100;
export const MAX_TAG_NAME_LENGTH = 40;

/**
 * The stored form of a tag name.
 *
 * Collapsing whitespace and trimming means "back end" and "back  end " are the
 * same tag rather than two that look identical in a list. Case is PRESERVED —
 * an org that writes "React" should see "React" — but uniqueness is enforced
 * case-insensitively by the caller comparing normalized-lowercase names, so
 * "react" cannot become a second tag beside it.
 */
export function normalizeTagName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_TAG_NAME_LENGTH);
}

/** The key uniqueness is decided on — see normalizeTagName. */
export function tagKey(raw: string): string {
  return normalizeTagName(raw).toLocaleLowerCase('tr');
}

export function isValidTagName(raw: string): boolean {
  const name = normalizeTagName(raw);
  return name.length > 0 && name.length <= MAX_TAG_NAME_LENGTH;
}

export type TagMode = 'and' | 'or';

export function isTagMode(value: string | null | undefined): value is TagMode {
  return value === 'and' || value === 'or';
}

/**
 * Parse the `?tags=` parameter. Ids only, deduped, and capped at the per-user
 * ceiling — a filter asking for more tags than a person can carry is either a
 * mistake or an attempt to make the database do pointless work.
 */
export function parseTagIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))].slice(0, MAX_TAGS_PER_USER);
}
