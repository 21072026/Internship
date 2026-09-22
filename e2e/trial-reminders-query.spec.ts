import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail } from './helpers/db';
// Static imports, not `await import()`: Playwright resolves the `@/…` alias when
// it transforms the spec's import graph, Node at runtime does not.
import { findDueTrialReminders, trialActiveStageKey } from '../src/lib/trialReminders';
import {
  TRIAL_ACTIVE_STAGE_KEY,
  defaultTemplateForVertical,
  templateStagePayload,
} from '../src/lib/programTemplates';

// The trial reminder selection, against a real database (#2413, #2414).
//
// The pure rule is unit-tested without a database
// (scripts/test/trial-reminder-rule.test.mjs) and that is where the calendar-day
// arithmetic is pinned. THIS spec exists for the two claims the rule cannot make
// on its own, because both are about the round trip:
//
//   1. the candidate query actually finds a trial — the right stage key resolved
//      from the tenant's OWN PipelineStage rows, the right org, the right status;
//   2. "a second run for the same threshold sends zero" (#2414's acceptance
//      criterion) — a claim row written between two calls suppresses the mark,
//      through the real `TrialReminder` table rather than through a hand-made
//      `sentThresholds` array.
//
// Nothing is sent here: `findDueTrialReminders` deliberately writes nothing and
// mails nothing — the sender is #2415. What this proves is that when that job
// arrives, running it twice cannot write to the same customer twice.

test.afterAll(async () => {
  await prisma.$disconnect();
});

const DAY = 24 * 60 * 60 * 1000;

test('a trial due in seven days is selected once, and a claim row silences it', async () => {
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const ownerEmail = uniqueEmail(`trial-owner-${stamp}`);
  const leadEmail = uniqueEmail(`trial-lead-${stamp}`);
  const otherLeadEmail = uniqueEmail(`trial-other-${stamp}`);

  const org = await prisma.organization.create({
    data: { name: `Trial Query ${stamp}`, slug: `trial-query-${stamp}`, vertical: 'MARKETING' },
  });
  const owner = await seedUser(ownerEmail, 'TrialPass123!', 'MENTOR', 'Trial Owner');
  const lead = await seedUser(leadEmail, 'TrialPass123!', 'MENTEE', 'Trial Lead');
  const otherLead = await seedUser(otherLeadEmail, 'TrialPass123!', 'MENTEE', 'Other Lead');

  try {
    for (const u of [owner, lead, otherLead]) {
      await prisma.user.update({ where: { id: u.id }, data: { orgId: org.id } });
    }

    // The tenant's own stage rows, from the shipped preset — the key is never
    // written as a literal at a query site (check:stage-keys).
    const preset = defaultTemplateForVertical('MARKETING')!;
    await prisma.pipelineStage.createMany({
      data: templateStagePayload(preset).stages.map((s) => ({ ...s, orgId: org.id })),
    });
    expect(await trialActiveStageKey(org.id)).toBe(TRIAL_ACTIVE_STAGE_KEY);

    // A tick at an awkward hour, and a trial whose last day is seven calendar
    // days later at an even more awkward one. A timestamp comparison would put
    // these 6.06 days apart and miss the mark entirely; the calendar-day rule
    // does not care what o'clock either of them is.
    const now = new Date(Date.UTC(2026, 4, 11, 23, 40));
    const endsAt = new Date(Date.UTC(2026, 4, 18, 0, 30));

    const relation = await prisma.mentorshipRelation.create({
      data: {
        orgId: org.id,
        mentorId: owner.id,
        menteeId: lead.id,
        pipelineStatus: TRIAL_ACTIVE_STAGE_KEY,
        trialStartedAt: new Date(endsAt.getTime() - 30 * DAY),
        trialEndsAt: endsAt,
      },
    });

    // A second record in the same stage, inside the query's window but off the
    // ladder on BOTH ticks below (five days out, then one). It is the control
    // that shows the selection is an exact calendar-day match and not
    // "everything in the stage that is roughly due".
    const notDue = await prisma.mentorshipRelation.create({
      data: {
        orgId: org.id,
        mentorId: owner.id,
        menteeId: otherLead.id,
        pipelineStatus: TRIAL_ACTIVE_STAGE_KEY,
        trialEndsAt: new Date(Date.UTC(2026, 4, 16, 12, 0)),
      },
    });

    const first = await findDueTrialReminders(org.id, { now });
    expect(first.map((d) => ({ relationId: d.relationId, threshold: d.threshold, daysRemaining: d.daysRemaining })))
      .toEqual([{ relationId: relation.id, threshold: 7, daysRemaining: 7 }]);
    expect(first[0].relation.mentorId).toBe(owner.id);
    expect(first.some((d) => d.relationId === notDue.id)).toBe(false);

    // THE CLAIM. The job (#2415) writes this row before it sends, so a
    // mid-send crash loses a reminder rather than duplicating one — the
    // reasoning is on the model in prisma/schema.prisma.
    await prisma.trialReminder.create({
      data: { orgId: org.id, relationId: relation.id, threshold: 7 },
    });

    // Second run, same tick: zero. This is #2414's acceptance criterion, and the
    // only place it is proved through the database rather than through the rule.
    expect(await findDueTrialReminders(org.id, { now })).toEqual([]);

    // The claim is per THRESHOLD, not per record: the same trial is picked up
    // again four days later for its 3-day mark, which is what makes the ladder a
    // ladder rather than one mail.
    const laterTick = new Date(Date.UTC(2026, 4, 15, 6, 0));
    const second = await findDueTrialReminders(org.id, { now: laterTick });
    expect(second.map((d) => [d.relationId, d.threshold])).toEqual([[relation.id, 3]]);
    expect(second.some((d) => d.relationId === notDue.id)).toBe(false);

    // A closed record is not waiting for anything, whatever its dates still say.
    await prisma.mentorshipRelation.update({
      where: { id: relation.id },
      data: { status: 'COMPLETED' },
    });
    expect(await findDueTrialReminders(org.id, { now: laterTick })).toEqual([]);
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { orgId: org.id } }).catch(() => {});
    await prisma.pipelineStage.deleteMany({ where: { orgId: org.id } }).catch(() => {});
    for (const email of [ownerEmail, leadEmail, otherLeadEmail]) {
      await prisma.user.deleteMany({ where: { email } }).catch(() => {});
    }
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
  }
});

test('an org without the trial stage is skipped rather than swept', async () => {
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const org = await prisma.organization.create({
    data: { name: `No Trial ${stamp}`, slug: `no-trial-${stamp}`, vertical: 'INTERNSHIP' },
  });
  try {
    // No PipelineStage rows at all: an INTERNSHIP tenant resolves to the
    // canonical built-ins, which have no trial stage. The sweep must return
    // nothing rather than fall back to a key that matches nothing.
    expect(await trialActiveStageKey(org.id)).toBeNull();
    expect(await findDueTrialReminders(org.id)).toEqual([]);
  } finally {
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
  }
});
