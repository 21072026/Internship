// Pure helpers for the mentee-facing mentor directory (#1820).
//
// `/api/mentors` still has to run the skill/language filters in JavaScript:
// both live inside a JSON array column that MySQL cannot search
// case-insensitively, so they are blocked on the Skill/UserSkill taxonomy join
// table (#1815). Until that lands the route reads a bounded window of rows and
// filters it in memory — and the whole point of #1820 is that the boundary is
// reported honestly instead of being silently passed off as the total.
//
// The arithmetic of "did we actually hit the cap?" and "which slice is this
// page?" is what got the previous implementation wrong, so it lives here as
// I/O-free functions with unit tests (`npm run test:mentor-directory`) rather
// than inside a route handler that only an e2e run with 2000 seeded mentors
// could ever exercise.

/**
 * Resolve a `take: cap + 1` read into the page-visible rows plus an exact
 * "there is more behind this" flag.
 *
 * The caller MUST have read one row past the cap. That extra row is the probe:
 * with a plain `take: cap` a full result and a truncated one are
 * indistinguishable (`rows.length === cap` either way), which makes a complete
 * answer claim to be partial — the mirror image of the bug #1820 is about.
 */
export function applyScanCap<T>(rows: T[], cap: number): { rows: T[]; truncated: boolean } {
  if (rows.length > cap) return { rows: rows.slice(0, cap), truncated: true };
  return { rows, truncated: false };
}

/** JSON array columns (`skills`, `languages`) come back as `unknown`. */
export function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v)) : [];
}

export interface DirectoryFilterRow {
  skills: unknown;
  languages: unknown;
  interests: string | null;
}

/**
 * The skill/language half of the directory filter. `skill` also matches the
 * free-text `interests` field, which is how a mentor who wrote "React, Next.js"
 * in prose rather than in the skills array is still findable. Both needles are
 * compared case-insensitively; an empty needle is "no filter".
 */
export function matchesTextFilters(row: DirectoryFilterRow, skill: string, language: string): boolean {
  const needleSkill = skill.trim().toLowerCase();
  if (needleSkill) {
    const hit =
      toStringArray(row.skills).some((s) => s.toLowerCase().includes(needleSkill)) ||
      (row.interests ?? '').toLowerCase().includes(needleSkill);
    if (!hit) return false;
  }
  const needleLanguage = language.trim().toLowerCase();
  if (needleLanguage) {
    if (!toStringArray(row.languages).some((l) => l.toLowerCase().includes(needleLanguage))) return false;
  }
  return true;
}

/** 1-based page slice. */
export function pageSlice<T>(rows: T[], page: number, pageSize: number): T[] {
  return rows.slice((page - 1) * pageSize, page * pageSize);
}
