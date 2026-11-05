// "Unassigned" candidates (#1440) — client-safe, no Prisma import.
//
// A candidate is unassigned when they have no ACTIVE relation. A finished
// (COMPLETED) pairing does not count: that person can be matched again, and an
// admin looking for "who is waiting?" wants them in the queue. Only the LIST
// semantics change here; the portal's own reading of a finished pairing
// (#1397/#1408) is untouched.
//
// The stage filter of /admin/candidates and `GET /api/candidates?status=`
// carry this value in the same parameter as a stage key. It is not a stage key
// and never can be one: keys are upper-case (`APPLICATION_100`, a tenant's own
// `[A-Za-z0-9_]+`), and this value is reserved lower-case.

export const UNASSIGNED_FILTER = 'unassigned';

export function isUnassignedFilter(value: string | null | undefined): boolean {
  return value === UNASSIGNED_FILTER;
}

/** The User `where` fragment: no relation in ACTIVE status. */
export function unassignedMenteeWhere() {
  return { menteeRelations: { none: { status: 'ACTIVE' as const } } };
}

/** List order. The unassigned queue reads oldest-registered first: the longest wait. */
export type CandidateSort = 'newest' | 'oldest';

export function candidateSort(raw: string | null | undefined, status: string | null | undefined): CandidateSort {
  if (raw === 'oldest' || raw === 'newest') return raw;
  return isUnassignedFilter(status) ? 'oldest' : 'newest';
}
