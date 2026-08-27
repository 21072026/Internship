// ---------------------------------------------------------------------------
// "Which mentorship am I looking at?", answered for a mentee (#1408).
//
// Every portal page used to ask for `status: 'ACTIVE'` and nothing else, so the
// moment a mentorship was marked COMPLETED the mentee's mentor, company, stage
// bar, goals, evaluations and question history all vanished and the portal told
// them "no mentor assigned yet — an admin will assign you one once your profile
// is reviewed". Finishing the programme is its SUCCESS case, and it read as a
// data loss.
//
// So the rule is: the active mentorship if there is one, otherwise the most
// recently completed one, flagged as an archive. `isArchived` is what the pages
// use to keep the record readable while closing the write actions that only
// make sense inside a live mentorship (asking the mentor a question, requesting
// a meeting, moving goals) — see the panels' `readOnly` props and the matching
// server-side guards in the questions / meeting-requests / goals routes.
//
// The pick happens in JS rather than in an `orderBy` because "ACTIVE before
// COMPLETED" is only expressible in SQL by relying on the declaration order of
// the MentorshipStatus enum — true today, silently wrong the day someone
// reorders it. A mentee has a handful of relations at most, so one findMany and
// a pick here costs nothing and says what it means.
// ---------------------------------------------------------------------------

/** Statuses a mentee's portal will render — anything else is not their record. */
export const MENTEE_RELATION_STATUSES = ['ACTIVE', 'COMPLETED'] as const;

/** `where` matching the relations a mentee's portal may show. */
export function menteeRelationWhere(menteeId: string) {
  return { menteeId, status: { in: [...MENTEE_RELATION_STATUSES] } };
}

interface PickableRelation {
  status: string;
  completedAt: Date | null;
  startDate: Date;
}

export interface MenteeRelationState<T> {
  /** The relation to render, or null when this mentee never had one. */
  relation: T | null;
  /** True when `relation` is a finished mentorship shown as an archive. */
  isArchived: boolean;
}

/**
 * Pick the mentorship a mentee's portal should render out of the rows returned
 * by `menteeRelationWhere`. Generic so each page keeps its own `select`.
 *
 * An ACTIVE relation always wins. Otherwise the most recently completed one —
 * by `completedAt`, falling back to `startDate` for rows completed before that
 * column was backfilled (prisma/backfill-relation-completed-at.mjs).
 */
export function pickMenteeRelation<T extends PickableRelation>(relations: T[]): MenteeRelationState<T> {
  // Both branches sort rather than take the first row: duplicate mentorships do
  // occur (#419) and an unordered findFirst used to resolve them by whatever
  // order MySQL happened to return, so the portal could show a different mentor
  // between two loads.
  const newestFirst = (by: (r: T) => Date) => (a: T, b: T) => by(b).getTime() - by(a).getTime();

  const active = relations.filter((r) => r.status === 'ACTIVE').sort(newestFirst((r) => r.startDate))[0];
  if (active) return { relation: active, isArchived: false };

  const latestCompleted = relations
    .filter((r) => r.status === 'COMPLETED')
    .sort(newestFirst((r) => r.completedAt ?? r.startDate))[0];

  return { relation: latestCompleted ?? null, isArchived: !!latestCompleted };
}

/**
 * Whether a write must be refused because the actor is the mentee of a
 * mentorship that has ended (#1408). The portal already hides these actions on
 * an archive; this is the server-side half of the same rule, so a hand-rolled
 * request cannot do what the UI does not offer.
 *
 * Deliberately scoped to the mentee. A mentor or admin still writes on a
 * COMPLETED relation on purpose — the certificate flow keys off exactly that
 * state (`canIssueCertificate`, src/lib/certificateEligibility.ts) and a final
 * evaluation is normally written after the mentorship ends.
 */
export function menteeWriteClosed(
  relation: { status: string; menteeId: string },
  userId: string
): boolean {
  return relation.menteeId === userId && relation.status !== 'ACTIVE';
}

/** The response body every route uses for that refusal — the same shape
 *  POST /api/weekly-reports already answers for a report on a
 *  mentorship that is no longer ACTIVE. */
export const INACTIVE_RELATION_ERROR = {
  error: 'The mentorship is not active',
  code: 'inactive_relation',
} as const;
