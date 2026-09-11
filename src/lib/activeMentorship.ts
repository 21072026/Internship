import type { Prisma } from '@prisma/client';

// ---------------------------------------------------------------------------
// ONE MENTEE, AT MOST ONE ACTIVE MENTOR (EPIC F / #419).
//
// This was always the intended invariant — POST /api/mentorship and the
// request-approval path have answered 409 for it since the beginning — but it
// was enforced at those two front doors only, by two hand-rolled `findFirst`s
// that had drifted apart, and skipped entirely at four other write paths. A
// guard with a hole is the same bug, so the question lives here now and every
// write path asks it through this module:
//
//   1. POST /api/mentorship                  — direct admin assignment
//   2. src/lib/mentorshipDecision.ts         — approving a MentorshipRequest
//   3. PUT /api/mentorship/[id]              — reopening a COMPLETED relation
//   4. POST /api/register                    — the invitation auto-link (#51)
//   5. POST /api/invite                      — refuses the pre-link up front
//   6. POST /api/mentor/mentees              — mentor-created mentee
//   7. src/lib/mergeUsers.ts                 — duplicate-account merge
//   8. src/lib/mentorTransfer.ts             — admin mentor transfer (#2289)
//
// scripts/import-csv.mjs is the ninth and the one seam: tsconfig excludes
// `scripts/`, so a .mjs file cannot import this TS module. It carries the same
// filter inline with a comment pointing here.
//
// THE BACKSTOP IS NOT HERE YET. MySQL has no partial unique index, so the
// technique is a nullable `activeMenteeKey` (= menteeId while ACTIVE, NULL
// otherwise) with @@unique — MySQL permits many NULLs. That is a deliberate
// FOLLOW-UP: if the live database already holds a mentee with two ACTIVE
// relations, adding the constraint makes `prisma db push --accept-data-loss`
// fail, and that push is how this app deploys. The constraint lands once the
// integrity report (GET /api/admin/relation-integrity, or the deploy's
// `prisma/check-active-mentor-duplicates.mjs` step) reads clean on prod AND on
// the shared preview. Until then these guards are the whole enforcement — see
// docs/one-active-mentor.md.
// ---------------------------------------------------------------------------

/**
 * The singleton client or an interactive-transaction client. Taking both is
 * what lets a front door re-ask the question INSIDE the `$transaction` that
 * does the write, instead of a read-then-write with five awaits in between.
 * Same convention as `type Tx` in src/lib/mergeUsers.ts.
 */
export type RelationDb = Prisma.TransactionClient;

export interface ActiveMentorship {
  id: string;
  mentorId: string;
  startDate: Date;
}

/**
 * The mentee's current ACTIVE mentorship, or null.
 *
 * `orderBy` is not decoration: violating rows exist in the wild today, and an
 * unordered `findFirst` would name a different offender between two calls —
 * the same trap `pickMenteeRelation` documents in src/lib/menteeRelation.ts.
 *
 * Deliberately NOT filtered by orgId: `menteeId` is globally unique, and the
 * tenant middleware injects its own `where: { orgId }` for every scoped read
 * (src/lib/orgContext.ts) — a second, divergent scoping rule underneath the
 * central one is exactly what #543 exists to prevent.
 */
export async function findActiveMentorship(
  db: RelationDb,
  menteeId: string,
  opts?: { exceptRelationId?: string },
): Promise<ActiveMentorship | null> {
  return db.mentorshipRelation.findFirst({
    where: {
      menteeId,
      status: 'ACTIVE',
      ...(opts?.exceptRelationId ? { id: { not: opts.exceptRelationId } } : {}),
    },
    orderBy: { startDate: 'asc' },
    select: { id: true, mentorId: true, startDate: true },
  });
}

/**
 * "Does this mentee have an ACTIVE mentorship other than this one?" —
 * `exceptRelationId` is what the reopen path needs, where the relation being
 * changed is itself part of the comparison.
 */
export async function hasOtherActiveMentorship(
  db: RelationDb,
  menteeId: string,
  opts?: { exceptRelationId?: string },
): Promise<boolean> {
  return (await findActiveMentorship(db, menteeId, opts)) !== null;
}

/**
 * The one refusal body. `error` is byte-identical to the string POST
 * /api/mentorship has always returned — e2e/dup-guard-transliteration.spec.ts
 * asserts `/active mentorship/i` on it — and `code` is the stable, translatable
 * half the UI switches on. Do not "tidy" the sentence.
 */
export const ALREADY_MENTORED_ERROR = {
  error: 'This mentee already has an active mentorship relation',
  code: 'already_mentored',
} as const;

/**
 * The same refusal, plus WHO the current mentor is (#2289).
 *
 * `already_mentored` was a correct refusal an admin could not act on: it named
 * no mentor and there was no control that changed one, which is how people
 * learn to fake a completion. These two fields are what lets the assign dialog
 * say "X already mentors this person — transfer them instead" and link
 * straight to POST /api/mentorship/<id>/transfer.
 *
 * ADMIN-facing callers only: the mentor's name is a person's name attached to
 * a mentee, so this must not be answered to a public or self-service route.
 * `error` and `code` stay byte-identical to ALREADY_MENTORED_ERROR — several
 * callers and e2e/dup-guard-transliteration.spec.ts match on them — so this is
 * purely additive, and one extra query on the refusal path only.
 */
export async function alreadyMentoredBody(db: RelationDb, relationId: string) {
  const relation = await db.mentorshipRelation
    .findUnique({ where: { id: relationId }, select: { id: true, mentor: { select: { fullName: true } } } })
    .catch(() => null);
  return {
    ...ALREADY_MENTORED_ERROR,
    activeRelationId: relation?.id ?? relationId,
    activeMentorName: relation?.mentor.fullName ?? null,
  };
}

/**
 * Thrown from inside a `$transaction` so the guard rolls the write back rather
 * than leaving it committed behind a 409.
 */
export class AlreadyMentoredError extends Error {
  // Plain fields rather than constructor parameter properties: this module is
  // loaded by scripts/test/active-mentorship.test.mjs under node's strip-only
  // type stripping, which does not support them.
  readonly menteeId: string;
  readonly existingRelationId: string;

  constructor(menteeId: string, existingRelationId: string) {
    super('already_mentored');
    this.name = 'AlreadyMentoredError';
    this.menteeId = menteeId;
    this.existingRelationId = existingRelationId;
  }
}

export interface RelationIntegrityGroup {
  menteeId: string;
  menteeName: string;
  menteeEmail: string;
  orgId: string | null;
  relations: {
    id: string;
    mentorId: string;
    mentorName: string;
    startDate: Date;
    pipelineStatus: string;
    dormantSince: Date | null;
    dormantNudgeCount: number;
  }[];
}

export interface RelationIntegrityReport {
  checkedAt: Date;
  clean: boolean;
  /** Mentees holding more than one ACTIVE mentorship. */
  offendingMentees: number;
  /** Sum of (count - 1): exactly the rows the future unique index would reject. */
  extraRelations: number;
  groups: RelationIntegrityGroup[];
  truncated: boolean;
}

const MAX_GROUPS = 100;

/**
 * READ-ONLY. The report that tells an operator whether live data already
 * violates the invariant — the precondition for the DB-level constraint. Same
 * `status: 'ACTIVE'` filter as the guards above, on purpose: if the guard's
 * definition and the report's definition drift by one status value, the report
 * says clean and the constraint fails on deploy.
 */
export async function findMenteesWithMultipleActiveMentors(
  db: RelationDb,
): Promise<RelationIntegrityReport> {
  const grouped = await db.mentorshipRelation.groupBy({
    by: ['menteeId'],
    where: { status: 'ACTIVE' },
    _count: { _all: true },
    having: { menteeId: { _count: { gt: 1 } } },
  });

  const extraRelations = grouped.reduce((sum, g) => sum + (g._count._all - 1), 0);
  const menteeIds = grouped.slice(0, MAX_GROUPS).map((g) => g.menteeId);
  if (menteeIds.length === 0) {
    return {
      checkedAt: new Date(),
      clean: true,
      offendingMentees: 0,
      extraRelations: 0,
      groups: [],
      truncated: false,
    };
  }

  const rows = await db.mentorshipRelation.findMany({
    where: { menteeId: { in: menteeIds }, status: 'ACTIVE' },
    orderBy: { startDate: 'asc' },
    select: {
      id: true,
      menteeId: true,
      mentorId: true,
      orgId: true,
      startDate: true,
      pipelineStatus: true,
      // The two columns that say whether this mentee has already been
      // over-mailed by the dormant-first-contact nudge (#1499): the cap lives
      // on the RELATION, so two ACTIVE relations spend two budgets.
      dormantSince: true,
      dormantNudgeCount: true,
      mentee: { select: { fullName: true, email: true } },
      mentor: { select: { fullName: true } },
    },
  });

  const byMentee = new Map<string, RelationIntegrityGroup>();
  for (const r of rows) {
    let group = byMentee.get(r.menteeId);
    if (!group) {
      group = {
        menteeId: r.menteeId,
        menteeName: r.mentee.fullName,
        menteeEmail: r.mentee.email,
        orgId: r.orgId,
        relations: [],
      };
      byMentee.set(r.menteeId, group);
    }
    group.relations.push({
      id: r.id,
      mentorId: r.mentorId,
      mentorName: r.mentor.fullName,
      startDate: r.startDate,
      pipelineStatus: r.pipelineStatus,
      dormantSince: r.dormantSince,
      dormantNudgeCount: r.dormantNudgeCount,
    });
  }

  return {
    checkedAt: new Date(),
    clean: false,
    offendingMentees: grouped.length,
    extraRelations,
    groups: [...byMentee.values()].sort((a, b) => a.menteeName.localeCompare(b.menteeName)),
    truncated: grouped.length > MAX_GROUPS,
  };
}
