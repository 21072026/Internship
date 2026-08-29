// "Dormant first contact" suppression (mentor attention queue + staleness
// reminders).
//
// A lot of people sign up, get one message from a mentor, and are never heard
// from again. They sit forever in the pipeline's first stage, and every
// "no recent contact" / "no open goal" nudge fires for them again and again —
// which is how a mentor's attention queue ends up 26 rows long with nothing in
// it worth doing. The mentor already did their part; the ball is in the
// applicant's court.
//
// So: a relation still parked in the FIRST stage of its pipeline, where an
// outreach already went out and nothing came back, is treated as dormant and
// dropped from those nudges. It is a filter on reminders only — the relation
// itself, its stage and its history are untouched, and the mentee stays fully
// visible everywhere they were before (mentee list, pipeline board, search).
//
// Anything that looks like a live thread keeps the relation on the list:
//   - the mentee wrote a message,
//   - the mentee has an unanswered question,
//   - a meeting request is pending,
//   - the mentor put a deadline on the stage (a deliberate "chase this one").
// And a relation with no outreach at all is never dormant: there, the first
// message is exactly the thing the mentor still owes.

import { prisma } from './prisma';
import { onPathKeys } from './pipeline';
import { resolvePipelineStages } from './pipelineStages';

/**
 * How old the outreach must be before silence counts as dormancy.
 *
 * Without it the rule fires the day after a mentor writes: harmless while this
 * only suppressed reminders, but it now drives a visible "Dormant" badge and an
 * automated check-in, and calling somebody passive the morning after you wrote
 * to them is simply wrong. Fourteen days is the same threshold the attention
 * queue and the staleness reminder already use for "no recent contact", and it
 * also what schedules the first check-in: a relation becomes dormant on exactly
 * the day that mail is due, so being flagged is being due.
 */
export const DORMANT_GRACE_DAYS = 14;

export interface DormantCandidate {
  id: string;
  orgId: string | null;
  menteeId: string;
  pipelineStatus: string;
  stageDeadline: Date | null;
  /** Date of the most recent logged interaction, or null when there is none. */
  lastInteractionAt: Date | null;
}

// The first stage of a tenant's pipeline. Custom stages (#747) may rename or
// replace APPLICATION_100, so the key is resolved per org rather than hardcoded;
// an org on the built-in stages resolves to APPLICATION_100. Memoized per call
// site so the daily cron doesn't re-query for every relation.
function createFirstStageResolver() {
  const cache = new Map<string, string>();
  return async (orgId: string | null | undefined): Promise<string> => {
    const cacheKey = orgId ?? '';
    const hit = cache.get(cacheKey);
    if (hit) return hit;
    const stages = await resolvePipelineStages(orgId);
    const first = onPathKeys(stages)[0] ?? 'APPLICATION_100';
    cache.set(cacheKey, first);
    return first;
  };
}

// Which of the given relations are dormant first contacts. Returns a set of
// relation ids; the extra lookups are scoped to the first-stage relations only,
// so a caller passing its whole active set pays nothing for the rest.
export async function findDormantFirstContacts(relations: DormantCandidate[]): Promise<Set<string>> {
  const dormant = new Set<string>();
  if (relations.length === 0) return dormant;

  const firstStageKey = createFirstStageResolver();
  const candidates: DormantCandidate[] = [];
  for (const r of relations) {
    // A deadline the mentor set on purpose is a deliberate "chase this one".
    if (r.stageDeadline) continue;
    if (r.pipelineStatus !== (await firstStageKey(r.orgId))) continue;
    candidates.push(r);
  }
  if (candidates.length === 0) return dormant;

  const ids = candidates.map((r) => r.id);
  const [messages, openQuestions, pendingMeetings] = await Promise.all([
    // One row per (relation, sender) carrying that sender's latest message, not
    // the messages themselves: a chatty thread would otherwise pull its whole
    // history into memory, and the only questions here are "who wrote?" and
    // "when last?".
    prisma.message.groupBy({
      by: ['relationId', 'senderId'],
      where: { relationId: { in: ids } },
      _max: { createdAt: true },
    }),
    prisma.mentorQuestion.findMany({ where: { relationId: { in: ids }, answer: null }, select: { relationId: true } }),
    prisma.meetingRequest.findMany({ where: { relationId: { in: ids }, status: 'PENDING' }, select: { relationId: true } }),
  ]);

  // Reaching out is not the same as logging that you reached out. A mentor who
  // writes four times through the in-app messenger and never opens the
  // interaction form has done exactly the thing this rule is about, so the
  // outreach date is the later of the last logged interaction and the last
  // message from anybody who is not the mentee (mentor or admin).
  const lastOutreachMessage = new Map<string, Date>();
  const lastMenteeMessage = new Map<string, Date>();
  const byMentee = new Map(candidates.map((r) => [r.id, r.menteeId]));
  for (const row of messages) {
    if (!row.relationId) continue;
    const at = row._max.createdAt;
    if (!at) continue;
    const target = row.senderId === byMentee.get(row.relationId) ? lastMenteeMessage : lastOutreachMessage;
    const seen = target.get(row.relationId);
    if (!seen || at > seen) target.set(row.relationId, at);
  }

  const withOpenQuestion = new Set(openQuestions.map((q) => q.relationId));
  const withPendingMeeting = new Set(pendingMeetings.map((m) => m.relationId));
  const graceCutoff = new Date(Date.now() - DORMANT_GRACE_DAYS * 24 * 60 * 60 * 1000);

  for (const r of candidates) {
    const outreachCandidates = [r.lastInteractionAt, lastOutreachMessage.get(r.id) ?? null].filter(
      (d): d is Date => d !== null,
    );
    if (outreachCandidates.length === 0) continue; // Nobody has written yet.
    const lastOutreachAt = outreachCandidates.reduce((a, b) => (a > b ? a : b));
    // Still inside the grace period — the silence is not yet an answer.
    if (lastOutreachAt > graceCutoff) continue;
    // A reply AFTER the last outreach, not merely somewhere in the history: the
    // question is whether the ball is in their court right now. Someone who
    // chatted in June, was written to in August and said nothing since is
    // dormant again; someone who answered yesterday is not, and the mentor owes
    // *them* a reply — which is exactly why they belong on the queue.
    const repliedAt = lastMenteeMessage.get(r.id);
    if (repliedAt && repliedAt > lastOutreachAt) continue;
    if (withOpenQuestion.has(r.id) || withPendingMeeting.has(r.id)) continue;
    dormant.add(r.id);
  }
  return dormant;
}

/**
 * Persist the flag (#1508).
 *
 * The queue evaluates the rule live, which is what makes a mentee disappear
 * from it the moment they go quiet. But a *stored* state is what the mentee
 * list can badge and filter on, and what the "still interested?" check-in job
 * has to hang its counters off — a nudge count only means something if the
 * episode it belongs to has an identity. So this sweep is the single writer of
 * `dormantSince`, and it runs daily alongside the other reminder jobs.
 *
 * Clearing matters as much as setting: the moment a relation stops matching,
 * the stamp AND the nudge counters go, so somebody who resurfaces and then goes
 * quiet again months later is treated as a new episode rather than as a person
 * already written off.
 */
export async function sweepDormantFirstContacts() {
  const relations = await prisma.mentorshipRelation.findMany({
    where: { status: 'ACTIVE' },
    select: {
      id: true,
      orgId: true,
      menteeId: true,
      pipelineStatus: true,
      stageDeadline: true,
      dormantSince: true,
      interactions: { orderBy: { date: 'desc' }, take: 1, select: { date: true } },
    },
  });

  const dormant = await findDormantFirstContacts(
    relations.map((r) => ({
      id: r.id,
      orgId: r.orgId,
      menteeId: r.menteeId,
      pipelineStatus: r.pipelineStatus,
      stageDeadline: r.stageDeadline,
      lastInteractionAt: r.interactions[0]?.date ?? null,
    })),
  );

  const toFlag = relations.filter((r) => dormant.has(r.id) && !r.dormantSince).map((r) => r.id);
  const toClear = relations.filter((r) => !dormant.has(r.id) && r.dormantSince).map((r) => r.id);

  if (toFlag.length > 0) {
    await prisma.mentorshipRelation.updateMany({
      where: { id: { in: toFlag } },
      data: { dormantSince: new Date() },
    });
  }
  if (toClear.length > 0) {
    await prisma.mentorshipRelation.updateMany({
      where: { id: { in: toClear } },
      data: { dormantSince: null, dormantNudgeCount: 0, dormantNudgeSentAt: null },
    });
  }

  return { checked: relations.length, flagged: toFlag.length, cleared: toClear.length };
}
