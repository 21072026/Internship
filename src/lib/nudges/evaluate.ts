// The nudge evaluator bound to the database (#1684). Server-only.
//
//   nudge subscriber (an allowlisted event)  → evaluateNudgeEvent()
//   nudge.evaluate  (nightly scan)            → runNudgeScan()
//   nudge.send      (one person, one rule)    → runNudgeSend()
//
// `evaluateNudgeRule()` is THE evaluation: segment → candidates → the facts
// each protection needs → `planRecipients()` (./rule.ts) → one `nudge.send`
// job per remaining person through a `NudgeWriter`. The admin's dry run
// (#1686) is the SAME call with `DRY_RUN_WRITER`, a writer that does not
// write — so a preview is never a different program from the run it previews.
//
// At-least-once all the way down: the event can be redelivered, the scan can
// run twice, a send job can rerun. What makes that harmless is the
// `NudgeSend` row, unique on (ruleId, userId, dedupeKey): the evaluator skips a
// person who already has it, the send job's idempotency key repeats it, and
// the send job CLAIMS it (an insert) before it mails — a second claim loses on
// the unique index and sends nothing. Never deduped on "we already ran".
//
// Every query names its `orgId` and runs inside `runWithOrg()`: the worker has
// no session (src/lib/orgContext.ts).

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { runWithOrg } from '@/lib/orgContext';
import { enqueue } from '@/lib/jobs/queue';
import { outcomeStageKeysFrom, resolvePipelineStages } from '@/lib/pipelineStages';
import { outcomeForStage } from '@/lib/outcomeComms';
import { emailGroupAllowed } from '@/lib/emailGroups';
import { notificationCategoryAllowed } from '@/lib/notificationPrefs';
import { notifyIfAllowed } from '@/lib/notify';
import type { DeliveredEvent } from '@/lib/events/subscribers';
import {
  DROP_REASONS,
  MAX_AUDIENCE,
  NUDGE_EVENT_TRIGGERS,
  dedupeKeyFor,
  fillMessage,
  messageFor,
  nudgeSendJobKey,
  planRecipients,
  readStoredNudge,
  type DropReason,
  type NudgeTrigger,
  type RecipientFacts,
  type Segment,
} from './rule';
import { hasRelationConditions, relationMatches, segmentUserWhere, type SegmentRelation } from './segment';

/** The mail's opt-out group and the bell's category — a nudge is a reminder about the reader's own work. */
export const NUDGE_EMAIL_GROUP = 'task_reminders' as const;
export const NUDGE_INAPP_CATEGORY = 'interactions' as const;
/** Sends still in flight or delivered count against the caps; a SKIPPED one never reached anybody. */
const COUNTED = ['SENT', 'HELD'];

export const nudgeRuleSelect = {
  id: true,
  orgId: true,
  name: true,
  enabled: true,
  trigger: true,
  segment: true,
  delayMinutes: true,
  channel: true,
  subjectEn: true,
  subjectTr: true,
  subjectDe: true,
  bodyEn: true,
  bodyTr: true,
  bodyDe: true,
  maxPerUserPer30Days: true,
  cooldownDays: true,
} as const;
export type NudgeRuleRow = Prisma.NudgeRuleGetPayload<{ select: typeof nudgeRuleSelect }>;

export interface QueuedNudge {
  ruleId: string;
  orgId: string;
  userId: string;
  dedupeKey: string;
  eventId: string | null;
  runAt: Date;
  scheduled: boolean;
}

export interface NudgeWriter {
  queue(send: QueuedNudge): Promise<void>;
}

/** The live writer: one keyed `nudge.send` job per person. */
export const LIVE_WRITER: NudgeWriter = {
  queue: async (s) => {
    await enqueue(
      'nudge.send',
      { ruleId: s.ruleId, userId: s.userId, dedupeKey: s.dedupeKey, eventId: s.eventId },
      { orgId: s.orgId, runAt: s.runAt, maxAttempts: 3, idempotencyKey: nudgeSendJobKey(s.ruleId, s.userId, s.dedupeKey), trigger: s.scheduled ? 'schedule' : 'event' },
    );
  },
};

/** The dry run's writer: it writes nothing. */
export const DRY_RUN_WRITER: NudgeWriter = { queue: async () => {} };

export interface NudgeEvaluation {
  /** People the segment describes (before any protection). */
  matched: number;
  /** People who would be / were queued, with names for the dry run's sample. */
  recipients: { userId: string; name: string | null; role: 'MENTOR' | 'MENTEE' }[];
  dropped: Record<DropReason, number>;
  /** True when the audience hit MAX_AUDIENCE and was cut. */
  truncated: boolean;
}

const EMPTY = (): NudgeEvaluation => ({
  matched: 0,
  recipients: [],
  dropped: Object.fromEntries(DROP_REASONS.map((r) => [r, 0])) as Record<DropReason, number>,
  truncated: false,
});

/**
 * The stages the outcome guard keeps nudges away from, in `orgId`'s pipeline:
 * every ending the outcome mail speaks for (the automation engine's test,
 * `outcomeForStage()` — dropped, found elsewhere, the off-path endings), the
 * stages that mean "reached the outcome" (`outcomeStageKeysFrom()`, hired /
 * employed or a renamed pipeline's own final stages) and every terminal stage.
 * A person whose journey has ended is not nudged about it. The write-time gate
 * (#1686's routes) and the evaluator read the same set.
 */
export async function nudgeGuardStageKeys(orgId: string): Promise<Set<string>> {
  const stages = await resolvePipelineStages(orgId);
  const keys = new Set(outcomeStageKeysFrom(stages).finished);
  for (const s of stages) {
    if (s.isTerminal || outcomeForStage(s.key, { isOffPath: s.isOffPath ?? false }) !== null) keys.add(s.key);
  }
  return keys;
}

const relationSelect = {
  pipelineStatus: true,
  cohortId: true,
  startDate: true,
  dormantSince: true,
  statusChanges: { orderBy: { createdAt: 'desc' }, take: 5, select: { createdAt: true, fromStatus: true, toStatus: true } },
  interactions: { orderBy: { date: 'desc' }, take: 1, select: { date: true } },
} as const;

type LoadedRelation = Prisma.MentorshipRelationGetPayload<{ select: typeof relationSelect }>;

function asSegmentRelation(r: LoadedRelation): SegmentRelation {
  return { ...r, lastInteractionAt: r.interactions[0]?.date ?? null };
}

/** The facts every protection needs, for the people the segment describes. */
async function loadCandidates(
  rule: NudgeRuleRow,
  orgId: string,
  segment: Segment,
  dedupeKey: string,
  now: Date,
  restrictTo?: readonly string[],
): Promise<{ facts: RecipientFacts[]; truncated: boolean }> {
  const activeRel = { status: 'ACTIVE' as const, orgId };
  const users = await prisma.user.findMany({
    where: segmentUserWhere(segment, orgId, now, restrictTo),
    take: MAX_AUDIENCE + 1,
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      fullName: true,
      role: true,
      emailNotifications: true,
      notificationPrefs: true,
      mentorRelations: { where: activeRel, select: relationSelect },
      menteeRelations: { where: { orgId }, select: { ...relationSelect, status: true } },
    },
  });
  const truncated = users.length > MAX_AUDIENCE;
  const people = users.slice(0, MAX_AUDIENCE);
  const relational = hasRelationConditions(segment);
  const outcome = await nudgeGuardStageKeys(orgId);

  const inSegment = people.filter((u) => {
    if (!relational) return true;
    const rels = u.role === 'MENTOR' ? u.mentorRelations : u.menteeRelations.filter((r) => r.status === 'ACTIVE');
    return rels.some((r) => relationMatches(segment, asSegmentRelation(r), now));
  });
  const ids = inSegment.map((u) => u.id);
  if (ids.length === 0) return { facts: [], truncated };

  const since = new Date(now.getTime() - 30 * 86_400_000);
  const [recent, already] = await Promise.all([
    prisma.nudgeSend.findMany({ where: { orgId, userId: { in: ids }, sentAt: { gte: since }, status: { in: COUNTED } }, select: { userId: true, sentAt: true } }),
    prisma.nudgeSend.findMany({ where: { orgId, ruleId: rule.id, dedupeKey, userId: { in: ids } }, select: { userId: true } }),
  ]);
  const recentBy = new Map<string, Date[]>();
  for (const r of recent) recentBy.set(r.userId, [...(recentBy.get(r.userId) ?? []), r.sentAt]);
  const alreadySet = new Set(already.map((a) => a.userId));

  const facts = inSegment.map((u): RecipientFacts => {
    const email = rule.channel !== 'IN_APP' && emailGroupAllowed(u, NUDGE_EMAIL_GROUP);
    const inApp = rule.channel !== 'EMAIL' && notificationCategoryAllowed(u, NUDGE_INAPP_CATEGORY);
    return {
      userId: u.id,
      name: u.fullName,
      role: u.role === 'MENTOR' ? 'MENTOR' : 'MENTEE',
      reachable: email || inApp,
      // docs/dormant-first-contacts.md: any relation of theirs flagged dormant.
      dormant: u.menteeRelations.some((r) => r.dormantSince !== null),
      atOutcome: u.menteeRelations.some((r) => r.status === 'ACTIVE' && outcome.has(r.pipelineStatus)),
      recentSends: recentBy.get(u.id) ?? [],
      alreadySent: alreadySet.has(u.id),
    };
  });
  return { facts, truncated };
}

/**
 * THE evaluation. `restrictTo` narrows the audience to an event's people (or
 * to the one person a send job re-checks); `eventAt` anchors the delay.
 */
export async function evaluateNudgeRule(
  rule: NudgeRuleRow,
  opts: { writer: NudgeWriter; now?: Date; eventId?: string | null; eventAt?: Date; restrictTo?: readonly string[]; dedupeKey?: string },
): Promise<NudgeEvaluation> {
  const stored = readStoredNudge(rule);
  if (!stored || !rule.orgId) return EMPTY();
  const orgId = rule.orgId;
  const now = opts.now ?? new Date();
  const dedupeKey = opts.dedupeKey ?? dedupeKeyFor(stored.trigger, opts.eventId);
  const { facts, truncated } = await loadCandidates(rule, orgId, stored.segment, dedupeKey, now, opts.restrictTo);
  const plan = planRecipients(facts, rule, now);
  const runAt = new Date((opts.eventAt ?? now).getTime() + rule.delayMinutes * 60_000);
  for (const p of plan.send) {
    await opts.writer.queue({
      ruleId: rule.id,
      orgId,
      userId: p.userId,
      dedupeKey,
      eventId: opts.eventId ?? null,
      runAt: runAt < now ? now : runAt,
      scheduled: stored.trigger.kind === 'scan',
    });
  }
  return {
    matched: facts.length,
    recipients: plan.send.map((p) => ({ userId: p.userId, name: p.name, role: p.role })),
    dropped: plan.dropped,
    truncated,
  };
}

function isEventRule(trigger: NudgeTrigger, name: string): boolean {
  return trigger.kind === 'event' && trigger.event === name;
}

/** The `nudge` subscriber's body: every enabled rule of the event's org that listens to it. */
export async function evaluateNudgeEvent(event: DeliveredEvent, writer: NudgeWriter = LIVE_WRITER): Promise<number> {
  if (!event.orgId || !(NUDGE_EVENT_TRIGGERS as readonly string[]).includes(event.name)) return 0;
  const orgId = event.orgId;
  const relationId = typeof event.payload.relationId === 'string' ? event.payload.relationId : null;
  if (!relationId) return 0;
  return runWithOrg(orgId, async () => {
    const rules = (await prisma.nudgeRule.findMany({ where: { orgId, enabled: true }, select: nudgeRuleSelect })).filter((r) => {
      const s = readStoredNudge(r);
      return s !== null && isEventRule(s.trigger, event.name);
    });
    if (rules.length === 0) return 0;
    const relation = await prisma.mentorshipRelation.findFirst({ where: { id: relationId, orgId }, select: { mentorId: true, menteeId: true } });
    if (!relation) return 0;
    let queued = 0;
    for (const rule of rules) {
      const r = await evaluateNudgeRule(rule, {
        writer,
        eventId: event.id,
        eventAt: new Date(event.createdAt),
        restrictTo: [relation.mentorId, relation.menteeId],
      });
      queued += r.recipients.length;
    }
    return queued;
  });
}

/** The `nudge.evaluate` job: every enabled scan rule, every org. */
export async function runNudgeScan(now: Date = new Date()): Promise<{ rules: number; queued: number; failed: number }> {
  const rules = await prisma.nudgeRule.findMany({ where: { enabled: true, orgId: { not: null } }, select: nudgeRuleSelect });
  const out = { rules: 0, queued: 0, failed: 0 };
  for (const rule of rules) {
    const s = readStoredNudge(rule);
    if (!s || s.trigger.kind !== 'scan' || !rule.orgId) continue;
    out.rules += 1;
    try {
      const r = await runWithOrg(rule.orgId, () => evaluateNudgeRule(rule, { writer: LIVE_WRITER, now }));
      out.queued += r.recipients.length;
      await prisma.nudgeRule.updateMany({ where: { id: rule.id, orgId: rule.orgId }, data: { lastEvaluatedAt: now } });
    } catch (e) {
      // One broken rule must not stop every other tenant's scan.
      out.failed += 1;
      logger.error('Nudge scan failed for a rule', { ruleId: rule.id, error: String(e) });
    }
  }
  return out;
}

export type NudgeSendOutcome = 'sent' | 'held' | 'skipped' | 'rule_off' | 'no_user' | DropReason;

/**
 * The `nudge.send` job: re-check the person against the rule NOW (a delay may
 * have passed: they may have left the segment, gone dormant, been nudged by
 * another rule or unsubscribed), claim the `NudgeSend` row, then deliver.
 */
export async function runNudgeSend(job: { ruleId: string; userId: string; dedupeKey: string; eventId: string | null }): Promise<NudgeSendOutcome> {
  const head = await prisma.nudgeRule.findUnique({ where: { id: job.ruleId }, select: { orgId: true } });
  if (!head?.orgId) return 'rule_off';
  const orgId = head.orgId;
  return runWithOrg(orgId, async () => {
    const rule = await prisma.nudgeRule.findFirst({ where: { id: job.ruleId, orgId, enabled: true }, select: nudgeRuleSelect });
    if (!rule) return 'rule_off';
    let decided: { queued: boolean } = { queued: false };
    const check = await evaluateNudgeRule(rule, {
      writer: { queue: async () => void (decided = { queued: true }) },
      restrictTo: [job.userId],
      dedupeKey: job.dedupeKey,
      eventId: job.eventId,
    });
    if (!decided.queued) {
      const reason = DROP_REASONS.find((r) => check.dropped[r] > 0);
      return reason ?? 'no_user';
    }
    const user = await prisma.user.findFirst({
      where: { id: job.userId, orgId, isActive: true },
      select: { id: true, email: true, fullName: true, role: true, preferredLanguage: true },
    });
    if (!user) return 'no_user';
    const message = messageFor(rule, user.preferredLanguage);
    if (!message) return 'skipped';

    // The claim: a rerun of this job, or a second job for the same key, loses here.
    let sendId: string;
    try {
      sendId = (
        await prisma.nudgeSend.create({
          data: { orgId, ruleId: rule.id, userId: user.id, dedupeKey: job.dedupeKey, eventId: job.eventId, channel: rule.channel, status: 'SENT' },
          select: { id: true },
        })
      ).id;
    } catch (e) {
      if ((e as { code?: string })?.code === 'P2002') return 'already_sent';
      throw e;
    }

    const body = fillMessage(message.body, user.fullName);
    let outcome: NudgeSendOutcome = 'sent';
    try {
      if (rule.channel !== 'EMAIL') {
        await notifyIfAllowed(user.id, NUDGE_INAPP_CATEGORY, 'nudge.message', { text: body.slice(0, 1_000) }, user.role === 'MENTOR' ? '/mentor' : '/portal');
      }
      if (rule.channel !== 'IN_APP' && user.email) {
        const { sendNudgeEmail } = await import('@/services/emailService');
        const result = await sendNudgeEmail({
          to: user.email,
          userId: user.id,
          orgId,
          locale: message.locale,
          subject: fillMessage(message.subject || rule.name, user.fullName),
          body,
          role: user.role === 'MENTOR' ? 'MENTOR' : 'MENTEE',
        });
        if (result === 'HELD') outcome = 'held';
        else if (result === 'SKIPPED' && rule.channel === 'EMAIL') outcome = 'skipped';
      }
    } catch (e) {
      // Nothing was delivered: release the claim so the retry can send it.
      await prisma.nudgeSend.deleteMany({ where: { id: sendId } }).catch(() => {});
      throw e;
    }
    if (outcome !== 'sent') {
      await prisma.nudgeSend.updateMany({ where: { id: sendId }, data: { status: outcome === 'held' ? 'HELD' : 'SKIPPED' } });
    }
    return outcome;
  });
}
