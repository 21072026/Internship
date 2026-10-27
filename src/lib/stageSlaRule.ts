// Which service level applies to one relation (#1640). Pure — no Prisma — so
// the rule is unit-tested (scripts/test/stage-sla-rule.test.mjs) and read the
// same way by the request path (src/lib/stageSla.ts) and by the deploy's
// deadline backfill (prisma/backfill-stage-deadlines.mjs imports this file's
// plain-ESM twin, prisma/stage-sla-rule.mjs; the unit test runs both).
//
// A `StageSla` row is scoped by two nullable columns, `cohortId` and
// `mentorId`. Both NULL is the org's own row — every row that existed before
// #1640 — so an org that never writes an override resolves exactly as before.
//
// PRECEDENCE, most specific first, per stage:
//
//   1. mentor + cohort — this mentor, inside this cohort
//   2. mentor          — this mentor, any cohort
//   3. cohort          — anybody in this cohort
//   4. org             — the org's own number
//
// A mentor carrying forty mentees is a property of the PERSON, which is why the
// mentor row beats the cohort row rather than the other way round: a cohort's
// fast track should not silently override the slack an admin gave one
// overloaded mentor. A scope with `days = null` on a stage does not take part
// for that stage (since #1439 a row can exist for its board WIP limit alone),
// so it never masks a less specific row that does carry a number.

export type SlaSource = 'mentorCohort' | 'mentor' | 'cohort' | 'org';

/** One `StageSla` row, as far as resolution is concerned. */
export interface StageSlaRow {
  stageKey: string;
  days: number | null;
  cohortId?: string | null;
  mentorId?: string | null;
}

/** The relation's coordinates: which cohort, which mentor. */
export interface SlaScope {
  cohortId?: string | null;
  mentorId?: string | null;
}

export interface ResolvedSla {
  days: number;
  source: SlaSource;
}

/** Most specific first — the order `resolveSlaDays` tries the scopes in. */
export const SLA_PRECEDENCE: readonly SlaSource[] = ['mentorCohort', 'mentor', 'cohort', 'org'];

/**
 * The value of `StageSla.scope` for a (cohortId, mentorId) pair. The ONLY
 * writer of that column: MySQL compares NULLs as distinct inside a unique
 * index, so the unique key is this string rather than the two nullable ids.
 */
export function slaScopeKey(scope: SlaScope): string {
  const cohortId = scope.cohortId || null;
  const mentorId = scope.mentorId || null;
  if (mentorId && cohortId) return `m:${mentorId}|c:${cohortId}`;
  if (mentorId) return `m:${mentorId}`;
  if (cohortId) return `c:${cohortId}`;
  return 'org';
}

/** Which precedence slot a row occupies for a relation in `scope`, or null when it does not apply. */
export function rowSource(row: SlaScope, scope: SlaScope): SlaSource | null {
  const rowCohort = row.cohortId || null;
  const rowMentor = row.mentorId || null;
  const cohortId = scope.cohortId || null;
  const mentorId = scope.mentorId || null;
  if (rowCohort && rowCohort !== cohortId) return null;
  if (rowMentor && rowMentor !== mentorId) return null;
  if (rowMentor && rowCohort) return 'mentorCohort';
  if (rowMentor) return 'mentor';
  if (rowCohort) return 'cohort';
  return 'org';
}

/**
 * The winning service level per stage for a relation in `scope`. Stages with no
 * applicable number are absent — so an empty map still means "this relation's
 * deadline is not SLA-managed", the flag `stageDeadlineUpdate` relies on.
 */
export function resolveSlaDays(rows: ReadonlyArray<StageSlaRow>, scope: SlaScope = {}): Map<string, ResolvedSla> {
  const out = new Map<string, ResolvedSla>();
  for (const row of rows) {
    if (row.days == null) continue;
    const source = rowSource(row, scope);
    if (!source) continue;
    const held = out.get(row.stageKey);
    if (!held || SLA_PRECEDENCE.indexOf(source) < SLA_PRECEDENCE.indexOf(held.source)) {
      out.set(row.stageKey, { days: row.days, source });
    }
  }
  return out;
}

/** The same resolution as plain `stageKey → days`, the shape most callers read. */
export function slaDaysByStage(rows: ReadonlyArray<StageSlaRow>, scope: SlaScope = {}): Map<string, number> {
  return new Map(Array.from(resolveSlaDays(rows, scope), ([key, r]) => [key, r.days]));
}

/**
 * What a relation in `scope` would get if the row AT exactly that scope did not
 * exist — the "inherited from" half the admin editor shows beside an override
 * ("this cohort: 5 days, inherited from org: 7 days").
 */
export function inheritedSla(rows: ReadonlyArray<StageSlaRow>, scope: SlaScope): Map<string, ResolvedSla> {
  const own = slaScopeKey(scope);
  return resolveSlaDays(
    rows.filter((r) => slaScopeKey(r) !== own),
    scope
  );
}
