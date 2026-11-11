// The programme filter of the analytics screens (#1652), the pure half.
//
// A programme is a `Cohort` (a relation's `cohortId`). The filter reads one
// query parameter, `?program=`:
//
//   · absent / empty / 'all' → every relation, exactly today's numbers;
//   · 'unassigned'           → relations with no programme at all — the bucket
//                              that makes the programmes add up to the tenant
//                              total instead of silently losing rows;
//   · anything else          → that programme's id. Whether the id belongs to
//                              the CALLER's tenant is the server half's
//                              question (src/lib/programFilter.ts), answered
//                              before a single number is computed.
//
// Free on every plan: a coordinator reading their own programme is core usage.
// Only the cross-programme COMPARISON (/api/admin/analytics/programs) is gated.

export const UNASSIGNED_PROGRAM = 'unassigned';

export type ProgramFilter = { kind: 'all' } | { kind: 'unassigned' } | { kind: 'program'; id: string };

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The parameter as a filter, or null for a value that cannot be an id at all. */
export function parseProgramParam(raw: string | null | undefined): ProgramFilter | null {
  const v = (raw ?? '').trim();
  if (v === '' || v === 'all') return { kind: 'all' };
  if (v === UNASSIGNED_PROGRAM) return { kind: 'unassigned' };
  return ID.test(v) ? { kind: 'program', id: v } : null;
}

/** The relation-side `where` fragment for a filter; `{}` for 'all'. */
export function relationProgramWhere(f: ProgramFilter): { cohortId?: string | null } {
  if (f.kind === 'all') return {};
  if (f.kind === 'unassigned') return { cohortId: null };
  return { cohortId: f.id };
}
