// The one rule for narrowing a mentor's mentee rows (#1367).
//
// WHY THIS IS A LIB AND NOT TWO `useState` FILTERS
//   The mentor has two views over the same rows — the card grid at
//   /mentor/mentees and the stage board at /mentor/board. Both needed "find a
//   mentee by name", and writing that twice guarantees they drift: one folds
//   diacritics and the other doesn't, one searches the university and the other
//   doesn't, and the mentor learns to trust neither. So the *matching* lives
//   here (dependency-free, unit-tested in scripts/test/mentee-filter.test.mjs)
//   and each page owns only its own controls.
//
//   This is deliberately NOT a board hook: extracting the admin board's
//   search/hideEmpty state into `useBoardFilters()` is #2076's job. This module
//   holds no state and renders nothing, so the two cannot collide.
//
// SERVER-SIDE OR CLIENT-SIDE?
//   Client-side, and honestly so: GET /api/mentorship only paginates when the
//   caller passes `page`, and neither mentor surface does — both already hold
//   every relation the mentor can see. Filtering the loaded array therefore
//   searches *all* of the mentor's mentees, not just a visible page, so there is
//   nothing to disclaim in the UI. If either page ever starts paging, the search
//   has to move into the query in the same change.
//
// STAGE KEYS ARE NEVER NAMED HERE
//   Stages are per-tenant since #747. `stage` is whatever key the caller got
//   from `useResolvedStages()`, compared as an opaque string; the empty string
//   means "every stage". No canonical enum member appears in this file.

export const MENTEE_STATUS_FILTERS = ['ALL', 'ACTIVE', 'COMPLETED'] as const;
export type MenteeStatusFilter = (typeof MENTEE_STATUS_FILTERS)[number];

/** The shape both mentor surfaces already have on hand from /api/mentorship. */
export interface MenteeFilterRow {
  status?: string | null;
  pipelineStatus?: string | null;
  mentee: {
    fullName?: string | null;
    email?: string | null;
    university?: string | null;
  };
}

export interface MenteeFilters {
  /** Raw text as typed — folded by `foldSearchText` before matching. */
  search: string;
  status: MenteeStatusFilter;
  /** A resolved stage key, or '' for every stage. */
  stage: string;
}

export const EMPTY_MENTEE_FILTERS: MenteeFilters = { search: '', status: 'ALL', stage: '' };

/**
 * Lowercase, and strip the accents this audience does not actually type.
 *
 * Mentors write "Sahin" looking for "Şahin" and "Muller" looking for "Müller";
 * a plain `toLowerCase().includes()` finds neither, and the mentor concludes the
 * search is broken rather than that their keyboard is. NFD decomposition plus
 * dropping the combining marks handles ş/ç/ö/ü/ğ/ä in one step. Turkish dotless
 * ı does not decompose, so it is mapped explicitly — otherwise "Isik" would miss
 * "Işık". (Dotted capital İ needs no special case: `toLowerCase()` turns it into
 * i + U+0307, which the mark-stripping step then reduces to a plain i.)
 */
export function foldSearchText(value: string): string {
  return value
    .replace(/ı/g, 'i')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

/** Does one row match an already-folded query? An empty query matches everything. */
export function matchesMenteeQuery(row: MenteeFilterRow, foldedQuery: string): boolean {
  if (!foldedQuery) return true;
  return [row.mentee.fullName, row.mentee.email, row.mentee.university].some(
    (field) => !!field && foldSearchText(field).includes(foldedQuery),
  );
}

/** Narrow the rows by search ∩ status ∩ stage. Input order is preserved. */
export function filterMenteeRows<T extends MenteeFilterRow>(rows: T[], filters: MenteeFilters): T[] {
  const q = foldSearchText(filters.search);
  if (!q && filters.status === 'ALL' && !filters.stage) return rows;
  return rows.filter(
    (row) =>
      (filters.status === 'ALL' || row.status === filters.status) &&
      (!filters.stage || row.pipelineStatus === filters.stage) &&
      matchesMenteeQuery(row, q),
  );
}

/** True when anything is narrowing the list — drives the "clear filters" button. */
export function hasActiveMenteeFilters(filters: MenteeFilters): boolean {
  return !!foldSearchText(filters.search) || filters.status !== 'ALL' || !!filters.stage;
}
