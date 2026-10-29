// The /api/v1 lifecycle policy (#1992) as data — the one place the public spec,
// the /developers page and docs/api-lifecycle.md read it from, so the three can
// never promise different windows. Pure: no imports, safe on the client.

/** How long a deprecated field, parameter or endpoint keeps working after it is announced. */
export const DEPRECATION_WINDOW_MONTHS = 6;

/**
 * Response headers a deprecated operation carries once one exists: `Deprecation`
 * (RFC 9745, the date it was deprecated) and `Sunset` (RFC 8594, the date it
 * stops answering). A deprecated KEY inside a response cannot be marked by a
 * header — that would mark the whole endpoint — so it is listed below instead.
 */
export const DEPRECATION_HEADERS = ['Deprecation', 'Sunset'] as const;

/** The day the pre-#1988 `candidates` alias key is removed from GET /candidates. */
export const CANDIDATES_ALIAS_SUNSET = '2027-01-31';

export interface ApiDeprecation {
  /** What goes away, in the spec's own words (English, like the spec). */
  what: string;
  /** The change that deprecated it. */
  since: string;
  /** ISO date it stops working. */
  sunset: string;
}

/** Every announced deprecation — mirrored by the table in docs/public-api.md § Deprecations. */
export const API_DEPRECATIONS: readonly ApiDeprecation[] = [
  { what: '`candidates` key on `GET /api/v1/candidates` (alias of `data`)', since: '#1988', sunset: CANDIDATES_ALIAS_SUNSET },
];
