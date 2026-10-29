import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { nudgeSendJobKey } from '@/lib/nudges/rule';
import { evaluateNudgeEvent, evaluateNudgeRule, runNudgeSend, DRY_RUN_WRITER, nudgeRuleSelect, type QueuedNudge } from '@/lib/nudges/evaluate';

// The nudge engine against the database (#1684). Drives the evaluator and the
// send job directly (no worker, no browser): a scan rule reaches exactly the
// mentee its segment describes; the dormancy guard, the outcome guard and an
// unsubscribe drop the others; a re-run and a second send produce no second
// NudgeSend; the 30-day cap counts the send that just happened.

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('a scan rule sends once, to its segment only, behind the hard limits', { tag: '@smoke' }, async () => {
  const stamp = `${Date.now()}-${Math.round(performance.now())}`;
  const org = await prisma.organization.create({ data: { name: `Nudge ${stamp}`, slug: `nudge-${stamp}` } });
  const emails = {
    mentor: uniqueEmail('nudge-mentor'),
    stuck: uniqueEmail('nudge-stuck'),
    fresh: uniqueEmail('nudge-fresh'),
    dormant: uniqueEmail('nudge-dormant'),
    muted: uniqueEmail('nudge-muted'),
    hired: uniqueEmail('nudge-hired'),
  };
  const mk = (k: keyof typeof emails, role: 'MENTOR' | 'MENTEE') => seedUser(emails[k], 'NudgePass123', role, `${k} person`, org.id);
  const mentor = await mk('mentor', 'MENTOR');
  const stuck = await mk('stuck', 'MENTEE');
  const fresh = await mk('fresh', 'MENTEE');
  const dormant = await mk('dormant', 'MENTEE');
  const muted = await mk('muted', 'MENTEE');
  const hired = await mk('hired', 'MENTEE');
  await prisma.user.update({ where: { id: muted.id }, data: { notificationPrefs: { interactions: false } } });

  const old = new Date(Date.now() - 30 * 86_400_000);
  const rel = (menteeId: string, pipelineStatus: string, extra: Record<string, unknown> = {}) =>
    prisma.mentorshipRelation.create({ data: { orgId: org.id, mentorId: mentor.id, menteeId, pipelineStatus, startDate: old, ...extra } });
  await rel(stuck.id, 'INTERVIEW_PENDING_250');
  await rel(fresh.id, 'INTERVIEW_PENDING_250', { startDate: new Date() });
  await rel(dormant.id, 'INTERVIEW_PENDING_250', { dormantSince: new Date() });
  await rel(muted.id, 'INTERVIEW_PENDING_250');
  await rel(hired.id, 'HIRED_660');

  const rule = await prisma.nudgeRule.create({
    data: {
      orgId: org.id,
      name: 'Stuck at interview',
      enabled: true,
      trigger: { kind: 'scan' },
      // No stage condition: the outcome guard, not the segment, must keep the hired mentee out.
      segment: { conditions: [{ field: 'role', op: 'eq', value: 'MENTEE' }, { field: 'daysInStage', op: 'gte', value: 10 }] },
      channel: 'IN_APP',
      bodyEn: 'Hi {name}, how is it going?',
      maxPerUserPer30Days: 1,
      cooldownDays: 0,
    },
    select: nudgeRuleSelect,
  });
  try {
    // The dry run: the audience and the drops, nothing written.
    const dry = await evaluateNudgeRule(rule, { writer: DRY_RUN_WRITER });
    expect(dry.recipients.map((r) => r.userId)).toEqual([stuck.id]);
    expect(dry.dropped).toMatchObject({ dormancy: 1, unsubscribed: 1, outcome: 1, already_sent: 0 });
    expect(await prisma.nudgeSend.count({ where: { ruleId: rule.id } })).toBe(0);

    // The live evaluation queues exactly the one person.
    const queued: QueuedNudge[] = [];
    await evaluateNudgeRule(rule, { writer: { queue: async (q) => void queued.push(q) } });
    expect(queued.map((q) => [q.userId, q.dedupeKey])).toEqual([[stuck.id, 'scan']]);

    // The send: one NudgeSend, one in-app notification.
    expect(await runNudgeSend({ ruleId: rule.id, userId: stuck.id, dedupeKey: 'scan', eventId: null })).toBe('sent');
    // A rerun of the same job sends nothing.
    expect(await runNudgeSend({ ruleId: rule.id, userId: stuck.id, dedupeKey: 'scan', eventId: null })).toBe('already_sent');
    expect(await prisma.nudgeSend.count({ where: { ruleId: rule.id } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId: stuck.id, type: 'nudge.message' } })).toBe(1);

    // Re-running the evaluator queues nobody: dedupe by NudgeSend.
    const again = await evaluateNudgeRule(rule, { writer: DRY_RUN_WRITER });
    expect(again.recipients).toHaveLength(0);
    expect(again.dropped.already_sent).toBe(1);

    // A second rule meets the 30-day cap the first rule's send just used up.
    const other = await prisma.nudgeRule.create({
      data: { ...rule, id: undefined, name: 'Second', segment: rule.segment ?? {}, trigger: rule.trigger ?? {}, maxPerUserPer30Days: 1, cooldownDays: 0 },
      select: nudgeRuleSelect,
    });
    const capped = await evaluateNudgeRule(other, { writer: DRY_RUN_WRITER });
    expect(capped.dropped.cap).toBe(1);
    expect(capped.recipients).toHaveLength(0);

    // A disabled rule's queued job sends nothing.
    await prisma.nudgeRule.update({ where: { id: other.id }, data: { enabled: false } });
    expect(await runNudgeSend({ ruleId: other.id, userId: fresh.id, dedupeKey: 'scan', eventId: null })).toBe('rule_off');
  } finally {
    await prisma.nudgeRule.deleteMany({ where: { orgId: org.id } }).catch(() => {});
    await prisma.mentorshipRelation.deleteMany({ where: { orgId: org.id } }).catch(() => {});
    for (const e of Object.values(emails)) await cleanupByEmail(e);
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
  }
});

test('an event rule with a 60-minute delay queues one send per matching person, an hour after the event, once', { tag: '@smoke' }, async () => {
  const stamp = `${Date.now()}-${Math.round(performance.now())}`;
  const org = await prisma.organization.create({ data: { name: `NudgeEv ${stamp}`, slug: `nudge-ev-${stamp}` } });
  const mentorEmail = uniqueEmail('nudge-ev-mentor');
  const menteeEmail = uniqueEmail('nudge-ev-mentee');
  const mentor = await seedUser(mentorEmail, 'NudgePass123', 'MENTOR', 'Ev Mentor', org.id);
  const mentee = await seedUser(menteeEmail, 'NudgePass123', 'MENTEE', 'Ev Mentee', org.id);
  const relation = await prisma.mentorshipRelation.create({ data: { orgId: org.id, mentorId: mentor.id, menteeId: mentee.id } });
  const rule = await prisma.nudgeRule.create({
    data: {
      orgId: org.id, name: 'After a logged interaction', enabled: true, delayMinutes: 60, channel: 'IN_APP', bodyEn: 'Nice work',
      trigger: { kind: 'event', event: 'interaction.logged' },
      segment: { conditions: [{ field: 'role', op: 'eq', value: 'MENTEE' }] },
    },
  });
  const event = await prisma.domainEvent.create({
    data: { orgId: org.id, name: 'interaction.logged', version: 1, payload: { relationId: relation.id, type: 'Meeting', date: new Date().toISOString() } },
  });
  try {
    const delivered = {
      id: event.id, name: event.name, version: 1, payload: event.payload as Record<string, unknown>, orgId: org.id,
      actorId: null, actorType: null, subjectType: null, subjectId: null, correlationId: null, createdAt: event.createdAt.toISOString(),
    };
    const queued: QueuedNudge[] = [];
    const writer = { queue: async (q: QueuedNudge) => void queued.push(q) };
    expect(await evaluateNudgeEvent(delivered, writer)).toBe(1);
    expect(queued[0]).toMatchObject({ ruleId: rule.id, userId: mentee.id, dedupeKey: `evt:${event.id}` });
    const delayMs = queued[0].runAt.getTime() - event.createdAt.getTime();
    expect(delayMs).toBeGreaterThanOrEqual(59 * 60_000);
    expect(delayMs).toBeLessThanOrEqual(61 * 60_000);
    // A redelivered event produces the same keyed send (the queue keeps one row).
    await evaluateNudgeEvent(delivered, writer);
    expect(nudgeSendJobKey(queued[1].ruleId, queued[1].userId, queued[1].dedupeKey)).toBe(nudgeSendJobKey(queued[0].ruleId, queued[0].userId, queued[0].dedupeKey));
    // Once sent, the same event reaches nobody again.
    expect(await runNudgeSend({ ruleId: rule.id, userId: mentee.id, dedupeKey: `evt:${event.id}`, eventId: event.id })).toBe('sent');
    expect(await evaluateNudgeEvent(delivered, DRY_RUN_WRITER)).toBe(0);
  } finally {
    await prisma.job.deleteMany({ where: { orgId: org.id } }).catch(() => {});
    await prisma.nudgeRule.deleteMany({ where: { orgId: org.id } }).catch(() => {});
    await prisma.domainEvent.deleteMany({ where: { orgId: org.id } }).catch(() => {});
    await prisma.mentorshipRelation.deleteMany({ where: { orgId: org.id } }).catch(() => {});
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeEmail);
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
  }
});
