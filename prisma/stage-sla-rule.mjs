// Plain-ESM twin of src/lib/stageSlaRule.ts (#1640), plus the deadline
// backfill's own pure plan. The server's Node 20 runs the deploy backfills
// without a TypeScript step, so prisma/backfill-stage-deadlines.mjs cannot
// import the .ts rule; scripts/test/stage-sla-rule.test.mjs runs one corpus
// through both copies. Change both in one commit.
//
// No imports: the backfill, the unit test and nothing else read it.

const DAY = 24 * 60 * 60 * 1000;

export const SLA_PRECEDENCE = ['mentorCohort', 'mentor', 'cohort', 'org'];

export function slaScopeKey(scope) {
  const cohortId = scope.cohortId || null;
  const mentorId = scope.mentorId || null;
  if (mentorId && cohortId) return `m:${mentorId}|c:${cohortId}`;
  if (mentorId) return `m:${mentorId}`;
  if (cohortId) return `c:${cohortId}`;
  return 'org';
}

export function rowSource(row, scope) {
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

export function resolveSlaDays(rows, scope = {}) {
  const out = new Map();
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

export function resolveSlaEscalations(rows, scope = {}) {
  const held = new Map();
  for (const row of rows) {
    if (row.days == null || row.escalateAfterDays == null || row.escalateAfterDays <= 0) continue;
    const source = rowSource(row, scope);
    if (!source) continue;
    const rank = SLA_PRECEDENCE.indexOf(source);
    const current = held.get(row.stageKey);
    if (!current || rank < current.rank) held.set(row.stageKey, { value: row.escalateAfterDays, rank });
  }
  return new Map(Array.from(held, ([key, v]) => [key, v.value]));
}

/**
 * When the relation entered the stage it is in now — the same rule as
 * `stageEnteredAt` in src/lib/stageClock.ts: the newest REAL move (a row whose
 * fromStatus equals its toStatus is no move, #2264), floored at startDate.
 * `entered.from` says which one it was, for the log.
 */
export function stageEntry(relation) {
  const started = new Date(relation.startDate).getTime();
  let moved = null;
  for (const c of relation.statusChanges ?? []) {
    if (c.fromStatus != null && c.toStatus != null && c.fromStatus === c.toStatus) continue;
    const at = new Date(c.createdAt).getTime();
    if (moved === null || at > moved) moved = at;
  }
  return moved !== null && moved > started ? { at: moved, from: 'statusChange' } : { at: started, from: 'startDate' };
}

/**
 * The backfill's decision for one ACTIVE relation that has no deadline:
 *   null                       → leave it (no service level applies here)
 *   { stageDeadline, pastDue } → write that deadline
 *
 * The deadline counts from the day the relation ENTERED the stage, not from
 * now: a candidate parked for ninety days must read overdue, not compliant.
 * `pastDue` is what the caller turns into the anti-storm stamps.
 */
export function planStageDeadline(relation, rows, now) {
  const sla = resolveSlaDays(rows, { cohortId: relation.cohortId, mentorId: relation.mentorId }).get(relation.pipelineStatus);
  if (!sla) return null;
  const entry = stageEntry(relation);
  const stageDeadline = new Date(entry.at + sla.days * DAY);
  return { stageDeadline, pastDue: stageDeadline.getTime() <= now.getTime(), source: sla.source, enteredFrom: entry.from };
}
