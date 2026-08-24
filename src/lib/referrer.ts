// Who brought a person in — ONE field, two possible kinds (#1296).
//
// History: `User.sourceId` (a `Source` row: school, agency, company, an
// acquaintance nobody registered) came first; #51 then added `User.referredById`
// (a registered person) as a *second* select on a *different* card of the
// candidate screen. Both answer the same question, so the app now treats them
// as a single "referrer" pointer with two backing columns, and the invariant
// below — at most one of them is set — is enforced on the API too
// (`PATCH /api/users/[id]`).
//
// The encoded string is what a <select> can carry as an option value:
//   ''             → not recorded
//   'user:<id>'    → a registered person
//   'source:<id>'  → a Source row

export const REFERRER_NONE = '';
/** Sentinel option value: "create a new source right here". */
export const REFERRER_NEW_SOURCE = '__new_source__';

export type ReferrerKind = 'user' | 'source';

export type ReferrerFields = {
  referredById?: string | null;
  sourceId?: string | null;
};

/** The select value for a person, given their two backing columns. */
export function encodeReferrer(fields: ReferrerFields): string {
  if (fields.referredById) return `user:${fields.referredById}`;
  if (fields.sourceId) return `source:${fields.sourceId}`;
  return REFERRER_NONE;
}

/**
 * The PATCH body for a picked option. Always writes *both* columns so the
 * previous kind is cleared — that is the whole point of the merge.
 */
export function decodeReferrer(value: string): { referredById: string | null; sourceId: string | null } {
  if (value.startsWith('user:')) return { referredById: value.slice(5) || null, sourceId: null };
  if (value.startsWith('source:')) return { referredById: null, sourceId: value.slice(7) || null };
  return { referredById: null, sourceId: null };
}

/** 'user' | 'source' | null — what kind of referrer an encoded value points at. */
export function referrerKind(value: string): ReferrerKind | null {
  if (value.startsWith('user:')) return 'user';
  if (value.startsWith('source:')) return 'source';
  return null;
}

/**
 * The one-line label for a person's referrer, for read-only views. Falls back to
 * the legacy free-text `referralSource` when no structured pointer is set, so a
 * record typed before the merge still reads as "came from X".
 */
export function referrerLabel(
  person: {
    referredBy?: { fullName: string } | null;
    source?: { name: string } | null;
    referralSource?: string | null;
  },
  fallback = ''
): string {
  if (person.referredBy?.fullName) return person.referredBy.fullName;
  if (person.source?.name) return person.source.name;
  if (person.referralSource) return person.referralSource;
  return fallback;
}
