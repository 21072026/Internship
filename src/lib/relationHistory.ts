// Does a mentorship pairing carry anything worth preserving? (#2289)
//
// Dependency-free on purpose — no Prisma import, no `@/` anything — so the unit
// test can load it under node's strip-only type stripping
// (scripts/test/mentor-transfer.test.mjs), the same reason
// src/lib/lastContactRule.ts and src/lib/menteeRelation.ts are.
//
// This predicate is the whole difference between the two honest outcomes of a
// mentor change: a pairing with no history is a MIS-ASSIGNMENT and gets its
// `mentorId` corrected in place; a pairing with history is a HANDOVER and is
// closed as ENDED_REASSIGNED with a successor relation behind it. See
// src/lib/mentorTransfer.ts and docs/mentor-transfer.md.

/** Child collections whose presence means "this pairing has a history". */
export const RELATION_HISTORY_COUNTS = [
  'interactions',
  'statusChanges',
  'meetings',
  'messages',
  'evaluations',
  'goals',
  'meetingRequests',
  'questions',
  'relationNotes',
  'offers',
  'weeklyReports',
] as const;

export type RelationHistoryCounts = Partial<Record<(typeof RELATION_HISTORY_COUNTS)[number], number>>;

/**
 * Pure predicate, unit-tested (scripts/test/mentor-transfer.test.mjs): does
 * this pairing carry anything worth preserving?
 *
 * Deliberately "any row at all" rather than a judgement per collection. The
 * two modes differ in whether a record of the pairing survives, so the bar for
 * keeping one has to be the lowest possible: a single logged phone call, one
 * chat message or one stage move is enough to make the pairing a real thing
 * that happened. `weeklyReportReminders` is excluded on purpose — it is a
 * "*SentAt" bookkeeping row the system writes on its own, so counting it would
 * make a mis-assignment un-correctable simply because the cron ran.
 */
export function hasRelationHistory(counts: RelationHistoryCounts): boolean {
  return RELATION_HISTORY_COUNTS.some((key) => (counts[key] ?? 0) > 0);
}

/**
 * The mentee's own journey: the fields a HANDOVER copies from the closed
 * relation onto its successor (#2289), and nothing else. The board must not
 * show a hired-track candidate back at the first stage because their mentor
 * changed, and a customer's agreed trial must not vanish — or restart — because
 * the account got a new owner (#2551): `trialStartedAt`/`trialEndsAt` are
 * copied as they are, so the successor carries the SAME window and the
 * reminder ladder and expiry sweep count from the same date.
 *
 * Kept as a list so the Prisma select in mentorTransfer.ts can be compared
 * against it (scripts/test/mentor-transfer.test.mjs): a field copied but not
 * selected would be copied as `undefined`, i.e. silently dropped.
 */
export const CARRIED_OVER_FIELDS = [
  'pipelineStatus',
  'stageDeadline',
  'companyId',
  'projectId',
  'cohortId',
  'trialStartedAt',
  'trialEndsAt',
] as const;

export type CarriedOverField = (typeof CARRIED_OVER_FIELDS)[number];

/** Pick the carried-over fields off the closing relation, verbatim. */
export function carriedOverFields<T extends Record<CarriedOverField, unknown>>(
  relation: T,
): Pick<T, CarriedOverField> {
  const out = {} as Pick<T, CarriedOverField>;
  for (const key of CARRIED_OVER_FIELDS) out[key] = relation[key];
  return out;
}
