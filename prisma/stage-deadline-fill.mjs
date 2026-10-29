// The core of the stage-deadline fill (#1640, #3203), shared by the deploy
// backfill (prisma/backfill-stage-deadlines.mjs, every org, once) and the
// admin's SLA save (src/app/api/admin/stage-sla/route.ts, that org only, every
// save). One implementation, so the two can never disagree about which
// relations get a deadline, from which date, or how the mail storm is held off.
// The full reasoning is the header of prisma/backfill-stage-deadlines.mjs.
//
// Plain ESM: the server's Node 20 runs the deploy copy without a TypeScript
// step; the app imports it through allowJs (the klaviyoReset precedent).
import { planStageDeadline, resolveSlaEscalations } from './stage-sla-rule.mjs';

const DAY = 24 * 60 * 60 * 1000;
const BATCH = 500;

/**
 * Fill `stageDeadline` for one org's ACTIVE relations that have none and whose
 * own scope resolves a service level for their stage.
 *
 * @param {any} db        a PrismaClient (or the app's extended client)
 * @param {string} orgId
 * @param {{ apply?: boolean, now?: Date, dayRuleFor?: (cohortId: string | null) => Promise<any> }} [options]
 *        apply=false is a dry run; dayRuleFor resolves the business-day rule of
 *        a relation's programme (#1638) — omitted, every deadline is calendar days
 * @returns {Promise<{ total: number, pastDue: number, fromStartDate: number, perStage: Map<string, { set: number, pastDue: number }> }>}
 */
export async function fillOrgStageDeadlines(db, orgId, options = {}) {
  const apply = options.apply === true;
  const now = options.now ?? new Date();
  const result = { total: 0, pastDue: 0, fromStartDate: 0, perStage: new Map() };
  // One rule per programme, resolved once (#1638).
  const rules = new Map();
  const ruleFor = async (cohortId) => {
    if (!options.dayRuleFor) return null;
    const key = cohortId ?? '';
    if (!rules.has(key)) rules.set(key, await options.dayRuleFor(cohortId ?? null));
    return rules.get(key);
  };

  const rows = await db.stageSla.findMany({
    where: { orgId, days: { not: null } },
    select: { stageKey: true, days: true, escalateAfterDays: true, cohortId: true, mentorId: true },
  });
  if (rows.length === 0) return result;
  const stageKeys = Array.from(new Set(rows.map((r) => r.stageKey)));

  let cursor;
  for (;;) {
    const relations = await db.mentorshipRelation.findMany({
      where: {
        orgId,
        status: 'ACTIVE',
        lifecycleState: 'ACTIVE',
        stageDeadline: null,
        pipelineStatus: { in: stageKeys },
        // A paused pair keeps its remaining days here and gets its deadline
        // back on resume (#1772); the re-engagement pool is not stuck.
        stageDeadlineRemainingDays: null,
        mentee: { reEngageAt: null },
      },
      select: {
        id: true,
        cohortId: true,
        mentorId: true,
        pipelineStatus: true,
        startDate: true,
        // Newest first; a run of no-op rows (#2264) longer than this is not a thing.
        statusChanges: {
          orderBy: { createdAt: 'desc' },
          take: 50,
          select: { fromStatus: true, toStatus: true, createdAt: true },
        },
      },
      orderBy: { id: 'asc' },
      take: BATCH,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (relations.length === 0) break;
    cursor = relations[relations.length - 1].id;

    for (const relation of relations) {
      const plan = planStageDeadline(relation, rows, now, await ruleFor(relation.cohortId));
      if (!plan) continue;
      if (apply) {
        const written = await db.mentorshipRelation.updateMany({
          where: { id: relation.id, stageDeadline: null, pipelineStatus: relation.pipelineStatus },
          data: {
            stageDeadline: plan.stageDeadline,
            deadlineReminderSentAt: plan.pastDue ? now : null,
          },
        });
        // Lost to a move or a parallel save: not ours to count.
        if (written.count !== 1) continue;
        // The relation's own rung, resolved like its days (#3204).
        const escalateAfterDays = resolveSlaEscalations(rows, relation).get(relation.pipelineStatus);
        if (plan.pastDue && escalateAfterDays) {
          await db.slaBreach.createMany({
            data: [
              {
                orgId,
                relationId: relation.id,
                stageKey: relation.pipelineStatus,
                dueAt: plan.stageDeadline,
                level: 1,
                snoozedUntil: new Date(now.getTime() + escalateAfterDays * DAY),
              },
            ],
            skipDuplicates: true,
          });
        }
      }
      const count = result.perStage.get(relation.pipelineStatus) ?? { set: 0, pastDue: 0 };
      count.set++;
      if (plan.pastDue) count.pastDue++;
      result.perStage.set(relation.pipelineStatus, count);
      result.total++;
      if (plan.pastDue) result.pastDue++;
      if (plan.enteredFrom === 'startDate') result.fromStartDate++;
    }
  }
  return result;
}
