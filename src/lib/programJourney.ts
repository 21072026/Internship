// The program journey sweep (#1852): turn the due ProgramSteps of every live
// programme into to-dos, content and nudges for its active pairs — once.
//
// RULES THIS FILE IS BUILT AROUND (the timing rules live in
// src/lib/programJourneyRule.ts):
//   • THE CLAIM IS THE UNIQUE. A ProgramStepRun row is inserted BEFORE anything
//     is delivered; @@unique([stepId, relationId]) makes a second sweep — the
//     same day, or a second replica — lose with P2002 and deliver nothing.
//     Delivery is at-most-once on purpose: a crash between the claim and the
//     notification leaves a row with neither deliveredAt nor skippedReason,
//     which reads as "claimed, not confirmed", never as a reason to send twice.
//   • NO BACKFILL. Only pairs whose anchor + offset lands inside the lookback
//     window are even queried, so publishing a journey on a live programme
//     leaves no row and sends nothing for the steps already behind them.
//   • BOUNDED. At most JOURNEY_BATCH deliveries per tick; the rest are still
//     inside the window tomorrow.
//   • IN-APP ONLY, THROUGH notifyIfAllowed. The step goes to the pair's bell
//     under the recipient's own `mentorship` preference. No mail and no rule
//     evaluation here: #1703's automation engine owns acting on conditions, and
//     two engines mailing one person on one day is the bug that would ship.
//
// Scheduled as the queued job `programJourney.run` (src/lib/jobs/schedules.ts,
// #1677) and runnable on its own as GET /api/cron?job=program-journey. Only the
// 'scheduler' lease holder enqueues it — and the unique claim makes a double
// run harmless anyway.

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { notifyIfAllowed } from '@/lib/notify';
import { notificationLink } from '@/lib/notificationLink';
import { eventLinkFor } from '@/lib/groupEvents';
import { audienceIncludesRole } from '@/lib/groupEventRule';
import { resolvePipelineStages } from '@/lib/pipelineStages';
import { shellCapabilities } from '@/lib/shellCapabilities';
import { defaultLocale, isLocale } from '@/i18n/config';
import {
  JOURNEY_BATCH,
  JOURNEY_LOOKBACK_DAYS,
  isDeliverable,
  isLiveStep,
  notificationTypeFor,
  readStepPayload,
  recipientsFor,
  resolveDueAt,
  satisfiedReason,
  stepTitle,
  stepUnresolvable,
  journeyStepStatus,
  type JourneyAction,
  type JourneySkipCondition,
  type SatisfactionFacts,
  type StepTimelineEntry,
} from '@/lib/programJourneyRule';

const DAY = 24 * 60 * 60 * 1000;

export interface JourneySweepResult {
  delivered: number;
  skipped: number;
  /** Lost the claim to another sweep (P2002). */
  alreadyClaimed: number;
  /** Steps that cannot be scheduled for this org — e.g. a stage its pipeline does not have. */
  unresolved: { stepId: string; reason: string }[];
}

type StepRow = Prisma.ProgramStepGetPayload<object>;

const RELATION_SELECT = {
  id: true,
  orgId: true,
  mentorId: true,
  menteeId: true,
  startDate: true,
  pipelineStatus: true,
} satisfies Prisma.MentorshipRelationSelect;
type RelationRow = Prisma.MentorshipRelationGetPayload<{ select: typeof RELATION_SELECT }> & {
  statusChanges?: { toStatus: string; createdAt: Date }[];
};

/**
 * When each observable fact behind `skipIf` first happened for one relation,
 * or null when it has not — only the ones asked for are looked up. The date is
 * the evidence the participant view shows ("meeting booked on 3 March").
 */
export async function satisfactionEvidence(relationId: string, conditions: readonly JourneySkipCondition[]): Promise<Partial<Record<JourneySkipCondition, Date | null>>> {
  const out: Partial<Record<JourneySkipCondition, Date | null>> = {};
  for (const cond of new Set(conditions)) {
    if (cond === 'meeting_exists') {
      const m = await prisma.meeting.findFirst({ where: { relationId, status: { not: 'CANCELLED' } }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } });
      out[cond] = m?.createdAt ?? null;
    }
    if (cond === 'goal_exists') out[cond] = (await prisma.goal.findFirst({ where: { relationId }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }))?.createdAt ?? null;
    if (cond === 'message_exists') out[cond] = (await prisma.message.findFirst({ where: { relationId }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }))?.createdAt ?? null;
    if (cond === 'interaction_logged') out[cond] = (await prisma.interactionLog.findFirst({ where: { relationId }, orderBy: { date: 'asc' }, select: { date: true } }))?.date ?? null;
  }
  return out;
}

async function satisfactionFacts(relationId: string, conditions: readonly JourneySkipCondition[]): Promise<SatisfactionFacts> {
  const evidence = await satisfactionEvidence(relationId, conditions);
  return Object.fromEntries(Object.entries(evidence).map(([k, at]) => [k, at !== null])) as SatisfactionFacts;
}

/** Why a step is already satisfied for one relation, or null when it should be delivered. */
export async function isSatisfied(step: Pick<StepRow, 'payload'>, relationId: string): Promise<string | null> {
  const cond = readStepPayload(step.payload).skipIf;
  if (!cond) return null;
  return satisfiedReason(step, await satisfactionFacts(relationId, [cond]));
}

/**
 * The window of anchor dates that put a step's due date inside the lookback
 * window today: anchor + offset ∈ [now − lookback, now].
 */
function anchorWindow(step: StepRow, now: Date) {
  return {
    gte: new Date(now.getTime() - (step.offsetDays + JOURNEY_LOOKBACK_DAYS) * DAY),
    lte: new Date(now.getTime() - step.offsetDays * DAY),
  };
}

/** The active pairs of a step's programme that may be due for it today and have no run yet. */
async function candidateRelations(step: StepRow, now: Date, take: number): Promise<RelationRow[]> {
  const base: Prisma.MentorshipRelationWhereInput = {
    orgId: step.orgId,
    cohortId: step.programId,
    status: 'ACTIVE',
    programStepRuns: { none: { stepId: step.id } },
  };
  const window = anchorWindow(step, now);
  if (step.anchor === 'RELATION_START') {
    return prisma.mentorshipRelation.findMany({ where: { ...base, startDate: window }, select: RELATION_SELECT, take });
  }
  const stageKey = readStepPayload(step.payload).stageKey;
  if (step.anchor !== 'STAGE_ENTRY' || !stageKey) return [];
  return prisma.mentorshipRelation.findMany({
    where: {
      ...base,
      OR: [
        { statusChanges: { some: { toStatus: stageKey, createdAt: window } } },
        // Created straight into the stage: no StatusChange row, the creation is the entry.
        { pipelineStatus: stageKey, startDate: window, statusChanges: { none: { toStatus: stageKey } } },
      ],
    },
    select: {
      ...RELATION_SELECT,
      statusChanges: { where: { toStatus: stageKey }, orderBy: { createdAt: 'asc' }, take: 1, select: { toStatus: true, createdAt: true } },
    },
    take,
  });
}

/**
 * The live steps of a relation's programme that are due for it right now and
 * have not run — what the participant view (#1855) shows as "due now".
 */
export async function dueSteps(relationId: string, now = new Date()): Promise<{ step: StepRow; dueAt: Date }[]> {
  const rel = await prisma.mentorshipRelation.findUnique({
    where: { id: relationId },
    select: {
      ...RELATION_SELECT,
      cohortId: true,
      statusChanges: { orderBy: { createdAt: 'asc' }, select: { toStatus: true, createdAt: true } },
      programStepRuns: { select: { stepId: true } },
    },
  });
  if (!rel?.cohortId) return [];
  const steps = await prisma.programStep.findMany({ where: { programId: rel.cohortId, orgId: rel.orgId }, orderBy: { order: 'asc' } });
  const ran = new Set(rel.programStepRuns.map((r) => r.stepId));
  const stageKeys = new Set((await resolvePipelineStages(rel.orgId)).map((s) => s.key));
  const facts = anchorFacts(rel);
  const out: { step: StepRow; dueAt: Date }[] = [];
  for (const step of steps) {
    if (ran.has(step.id) || !isLiveStep(step, now)) continue;
    const due = resolveDueAt(step, facts, stageKeys);
    if (due.kind === 'due' && isDeliverable(due.dueAt, now)) out.push({ step, dueAt: due.dueAt });
  }
  return out;
}

function anchorFacts(rel: { startDate: Date; statusChanges?: { toStatus: string; createdAt: Date }[]; pipelineStatus?: string }) {
  const stageEntries = new Map<string, Date>();
  for (const c of rel.statusChanges ?? []) if (!stageEntries.has(c.toStatus)) stageEntries.set(c.toStatus, c.createdAt);
  // A relation created straight into a stage entered it when it was created.
  if (rel.pipelineStatus && !stageEntries.has(rel.pipelineStatus)) stageEntries.set(rel.pipelineStatus, rel.startDate);
  // Program.startsAt arrives with #1622; until then a PROGRAM_START step is unresolved.
  return { relationStart: rel.startDate, programStart: null, stageEntries };
}

/** Deliver one step to the pair. Never throws for a single recipient (notify() does not). */
export async function materialise(step: StepRow, rel: Pick<RelationRow, 'id' | 'orgId' | 'mentorId' | 'menteeId'>): Promise<void> {
  const action = step.action as JourneyAction;
  const payload = readStepPayload(step.payload);
  const recipients = recipientsFor(step.audience, rel);
  const users = await prisma.user.findMany({
    where: { id: { in: recipients }, isActive: true },
    select: { id: true, preferredLanguage: true },
  });
  const capabilities = await shellCapabilities(rel.orgId);
  const localeOf = (lang: string | null) => (isLocale(lang ?? undefined) ? (lang as string) : defaultLocale);

  // A to-do is one Goal of the pair, worded in the mentee's language — the
  // person whose to-do it is. Visible to the pair (PAIR), like any goal.
  if (action === 'ASSIGN_TODO') {
    const mentee = await prisma.user.findUnique({ where: { id: rel.menteeId }, select: { preferredLanguage: true } });
    await prisma.goal.create({
      data: { relationId: rel.id, title: stepTitle(step, localeOf(mentee?.preferredLanguage ?? null)).slice(0, 191), visibility: 'PAIR' },
    });
  }

  // A group session step (#1856) points at one of the programme's own
  // sessions: delivering it publishes that session if it is still a draft, and
  // the invitation links to the session — to the people of the pair its
  // audience includes. A session that was called off, has started or left the
  // programme announces nothing; the step falls back to its plain nudge.
  const event = action === 'GROUP_SESSION' && payload.eventId ? await groupSessionFor(payload.eventId, rel.orgId) : null;

  for (const user of users) {
    const role = user.id === rel.mentorId ? 'MENTOR' : 'MENTEE';
    if (event) {
      if (!audienceIncludesRole(event.audience, role)) continue;
      await notifyIfAllowed(user.id, 'mentorship', notificationTypeFor(action), { title: stepTitle(step, localeOf(user.preferredLanguage)) }, eventLinkFor(role, event.id));
      continue;
    }
    // The bell routes inside the app, so only a same-app path becomes the
    // link; an external document is opened from the step's own page (#1855).
    const link = action === 'PUBLISH_CONTENT' && payload.url?.startsWith('/')
      ? payload.url
      : notificationLink(role, 'relation', { relationId: rel.id }, { capabilities });
    await notifyIfAllowed(user.id, 'mentorship', notificationTypeFor(action), { title: stepTitle(step, localeOf(user.preferredLanguage)) }, link);
  }
}

/** The live session a GROUP_SESSION step announces, published on first delivery; null when it cannot be. */
async function groupSessionFor(eventId: string, orgId: string | null, now = new Date()) {
  const event = await prisma.programEvent.findFirst({
    where: { id: eventId, orgId, cancelledAt: null, startsAt: { gt: now } },
    select: { id: true, audience: true, publishedAt: true },
  });
  if (!event) return null;
  // Guarded on `publishedAt: null`: two pairs delivered on the same tick publish it once.
  if (!event.publishedAt) await prisma.programEvent.updateMany({ where: { id: event.id, publishedAt: null }, data: { publishedAt: now } });
  return event;
}

/** Claim, check, deliver and record one (step, relation). */
async function runOne(step: StepRow, rel: RelationRow, dueAt: Date, now: Date, result: JourneySweepResult): Promise<void> {
  const skippedReason = await isSatisfied(step, rel.id);
  let runId: string;
  try {
    const run = await prisma.programStepRun.create({
      data: { stepId: step.id, relationId: rel.id, dueAt, skippedReason, deliveredAt: null },
      select: { id: true },
    });
    runId = run.id;
  } catch (error) {
    if ((error as { code?: string })?.code === 'P2002') {
      result.alreadyClaimed++;
      return;
    }
    throw error;
  }
  if (skippedReason) {
    result.skipped++;
    return;
  }
  await materialise(step, rel);
  await prisma.programStepRun.update({ where: { id: runId }, data: { deliveredAt: now } });
  result.delivered++;
}

/**
 * The daily sweep. `orgIds` narrows it to those tenants (an admin's
 * `job=program-journey`); without it every tenant with a live step is swept.
 * `now` pins the clock for tests.
 */
export async function runProgramJourney(opts: { now?: Date; orgIds?: string[]; batch?: number } = {}): Promise<JourneySweepResult> {
  const now = opts.now ?? new Date();
  const budget = Math.min(opts.batch ?? JOURNEY_BATCH, JOURNEY_BATCH);
  const result: JourneySweepResult = { delivered: 0, skipped: 0, alreadyClaimed: 0, unresolved: [] };

  const steps = await prisma.programStep.findMany({
    where: {
      publishedAt: { not: null, lte: now },
      archivedAt: null,
      ...(opts.orgIds ? { orgId: { in: opts.orgIds } } : {}),
    },
    orderBy: [{ programId: 'asc' }, { order: 'asc' }],
  });

  const stageCache = new Map<string, Set<string>>();
  const capabilityCache = new Map<string, boolean>();
  for (const step of steps) {
    if (result.delivered + result.skipped >= budget) break;
    if (!isLiveStep(step, now)) continue;
    const orgKey = step.orgId ?? '';
    if (!capabilityCache.has(orgKey)) capabilityCache.set(orgKey, (await shellCapabilities(step.orgId)).includes('mentorship'));
    // A vertical without mentor ↔ mentee pairs has no journey to deliver.
    if (!capabilityCache.get(orgKey)) continue;
    if (!stageCache.has(orgKey)) stageCache.set(orgKey, new Set((await resolvePipelineStages(step.orgId)).map((s) => s.key)));
    const stageKeys = stageCache.get(orgKey)!;

    // An anchor the org cannot provide is reported, not silently matched to nothing.
    const unresolvable = stepUnresolvable(step, stageKeys);
    if (unresolvable) {
      result.unresolved.push({ stepId: step.id, reason: unresolvable });
      continue;
    }

    const remaining = budget - result.delivered - result.skipped;
    for (const rel of await candidateRelations(step, now, remaining)) {
      const due = resolveDueAt(step, anchorFacts(rel), stageKeys);
      if (due.kind !== 'due' || !isDeliverable(due.dueAt, now)) continue;
      await runOne(step, rel, due.dueAt, now, result);
      if (result.delivered + result.skipped >= budget) break;
    }
  }
  if (result.unresolved.length > 0) {
    logger.warning('Program journey: steps the org cannot schedule', { steps: result.unresolved.slice(0, 20) });
  }
  return result;
}

/**
 * The dry-run timeline of a programme's journey against one of its relations
 * (#1853): every step, its computed date and what the sweep would do with it.
 * READS ONLY — it never claims a run, so previewing cannot deliver anything.
 * Null when the relation is not in the programme.
 */
export async function previewJourney(programId: string, relationId: string, now = new Date()): Promise<{ stepId: string; entry: StepTimelineEntry }[] | null> {
  const rel = await prisma.mentorshipRelation.findFirst({
    where: { id: relationId, cohortId: programId },
    select: {
      ...RELATION_SELECT,
      statusChanges: { orderBy: { createdAt: 'asc' }, select: { toStatus: true, createdAt: true } },
      programStepRuns: { select: { stepId: true, dueAt: true, deliveredAt: true, skippedReason: true } },
    },
  });
  if (!rel) return null;
  const steps = await prisma.programStep.findMany({ where: { programId }, orderBy: [{ order: 'asc' }, { createdAt: 'asc' }] });
  const stageKeys = new Set((await resolvePipelineStages(rel.orgId)).map((s) => s.key));
  const conditions = steps.flatMap((s) => {
    const c = readStepPayload(s.payload).skipIf;
    return c ? [c] : [];
  });
  const satisfaction = await satisfactionFacts(rel.id, conditions);
  const runs = new Map(rel.programStepRuns.map((r) => [r.stepId, r]));
  const facts = anchorFacts(rel);
  return steps.map((step) => ({ stepId: step.id, entry: journeyStepStatus(step, runs.get(step.id) ?? null, facts, stageKeys, satisfaction, now) }));
}

// ── Scheduling ───────────────────────────────────────────────────────────────


