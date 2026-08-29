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
    // No outreach yet, or a deadline the mentor set on purpose: never dormant.
    if (!r.lastInteractionAt || r.stageDeadline) continue;
    if (r.pipelineStatus !== (await firstStageKey(r.orgId))) continue;
    candidates.push(r);
  }
  if (candidates.length === 0) return dormant;

  const ids = candidates.map((r) => r.id);
  const [menteeMessages, openQuestions, pendingMeetings] = await Promise.all([
    // Grouped rather than listed: one row per (relation, sender) is all we need,
    // and a chatty thread would otherwise pull its whole history into memory.
    prisma.message.groupBy({ by: ['relationId', 'senderId'], where: { relationId: { in: ids } } }),
    prisma.mentorQuestion.findMany({ where: { relationId: { in: ids }, answer: null }, select: { relationId: true } }),
    prisma.meetingRequest.findMany({ where: { relationId: { in: ids }, status: 'PENDING' }, select: { relationId: true } }),
  ]);

  const repliedByMentee = new Set(
    menteeMessages
      .filter((m) => m.relationId !== null)
      .map((m) => `${m.relationId}:${m.senderId}`)
  );
  const withOpenQuestion = new Set(openQuestions.map((q) => q.relationId));
  const withPendingMeeting = new Set(pendingMeetings.map((m) => m.relationId));

  for (const r of candidates) {
    if (repliedByMentee.has(`${r.id}:${r.menteeId}`)) continue;
    if (withOpenQuestion.has(r.id) || withPendingMeeting.has(r.id)) continue;
    dormant.add(r.id);
  }
  return dormant;
}
