import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { setSetting } from '../src/lib/settings';
import { getAttentionItems } from '../src/lib/mentorAttention';
import { reminderDaysReader } from '../src/lib/relationHealthLive';
import { prisma as appPrisma } from '../src/lib/prisma';

// The readers moved onto the accessor (#1621) take the scope that exists where
// they run: a mentor's queue decides "no recent contact" by each relation's own
// programme, and a cross-tenant sweep resolves per relation, not once at the
// top. Speaks to the modules directly (no HTTP), so it holds whatever the
// server's flags are.

test.afterAll(async () => {
  await prisma.$disconnect();
  await appPrisma.$disconnect();
});

const DAY = 24 * 60 * 60 * 1000;

test('two programmes of one org nudge on their own reminderDays', async () => {
  const stamp = uniqueEmail('acc').replace(/[^a-z0-9]/gi, '').toLowerCase();
  const org = await prisma.organization.create({ data: { name: `Accessor ${stamp}`, slug: `acc-${stamp}` } });
  const tight = await prisma.cohort.create({ data: { name: `Tight ${stamp}`, orgId: org.id } });
  const loose = await prisma.cohort.create({ data: { name: `Loose ${stamp}`, orgId: org.id } });
  const emails = [uniqueEmail('acc-mentor'), uniqueEmail('acc-a'), uniqueEmail('acc-b')];
  try {
    const mentor = await seedUser(emails[0], 'AccMentor123!', 'MENTOR', 'Acc Mentor', org.id);
    const a = await seedUser(emails[1], 'AccMentee123!', 'MENTEE', 'Acc Tight', org.id);
    const b = await seedUser(emails[2], 'AccMentee123!', 'MENTEE', 'Acc Loose', org.id);
    const start = new Date(Date.now() - 60 * DAY);
    const relA = await prisma.mentorshipRelation.create({
      data: { orgId: org.id, mentorId: mentor.id, menteeId: a.id, cohortId: tight.id, pipelineStatus: 'JOB_SEEKING_500', startDate: start },
    });
    const relB = await prisma.mentorshipRelation.create({
      data: { orgId: org.id, mentorId: mentor.id, menteeId: b.id, cohortId: loose.id, pipelineStatus: 'JOB_SEEKING_500', startDate: start },
    });
    // Both pairs last spoke ten days ago.
    const tenDaysAgo = new Date(Date.now() - 10 * DAY);
    for (const relationId of [relA.id, relB.id]) {
      await prisma.interactionLog.create({ data: { relationId, date: tenDaysAgo, notes: 'synthetic', type: 'Meeting' } });
    }

    await setSetting('reminderDays', '30', org.id);
    await setSetting('reminderDays', '7', org.id, { programId: tight.id });

    const { items } = await getAttentionItems(mentor.id, { orgId: org.id });
    const reasonsOf = (id: string) => items.find((i) => i.relationId === id)?.reasons ?? [];
    expect(reasonsOf(relA.id)).toContain('inactive'); // 10 > 7: the tight programme nudges
    expect(reasonsOf(relB.id)).not.toContain('inactive'); // 10 < 30: the org's value holds
  } finally {
    await prisma.interactionLog.deleteMany({ where: { relation: { orgId: org.id } } });
    await prisma.mentorshipRelation.deleteMany({ where: { orgId: org.id } });
    await prisma.setting.deleteMany({ where: { orgId: org.id } });
    for (const e of emails) await cleanupByEmail(e);
    await prisma.cohort.deleteMany({ where: { orgId: org.id } });
    await prisma.organization.deleteMany({ where: { id: org.id } });
  }
});

test('a sweep across two tenants reads each tenant its own value', async () => {
  const stamp = uniqueEmail('acc2').replace(/[^a-z0-9]/gi, '').toLowerCase();
  const orgA = await prisma.organization.create({ data: { name: `Sweep A ${stamp}`, slug: `sweepa-${stamp}` } });
  const orgB = await prisma.organization.create({ data: { name: `Sweep B ${stamp}`, slug: `sweepb-${stamp}` } });
  try {
    await setSetting('reminderDays', '5', orgA.id);
    await setSetting('reminderDays', '21', orgB.id);
    // The reader the nightly health sweep and the admin monitor share: read
    // inside the loop, memoised per (org, programme) — never the first tenant's
    // value for everyone.
    const read = reminderDaysReader();
    expect(await read(orgA.id, null)).toBe(5);
    expect(await read(orgB.id, null)).toBe(21);
    expect(await read(orgA.id, null)).toBe(5);
  } finally {
    await prisma.setting.deleteMany({ where: { orgId: { in: [orgA.id, orgB.id] } } });
    await prisma.organization.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } });
  }
});
