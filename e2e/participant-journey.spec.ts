import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { gotoSettled, signInAndSettle } from './helpers/auth';

// The participant journey (#1855): both seats read one list with the same
// dates; a satisfied step shows its evidence instead of nagging; a draft is
// not on it; another relation's journey is 403; and the portal card does not
// overflow a 360px phone (the #1465 failure mode).

const PW = 'ParticipantJourney123!';
const DAY = 24 * 60 * 60 * 1000;

test.describe('participant journey', () => {
  const stamp = `${Date.now()}`;
  const mentor = uniqueEmail('pjv-mentor');
  const mentee = uniqueEmail('pjv-mentee');
  const stranger = uniqueEmail('pjv-stranger');
  let orgId = '';
  let relationId = '';
  const ids: Record<string, string> = {};

  test.beforeAll(async () => {
    orgId = (await prisma.organization.create({ data: { name: `PJV Org ${stamp}`, slug: `pjv-${stamp}` } })).id;
    await prisma.pipelineStage.createMany({ data: [{ orgId, key: 'LEAD_IN', label: 'Lead in', order: 0 }, { orgId, key: 'ON_THE_JOB', label: 'On the job', order: 1 }] });
    const programId = (await prisma.cohort.create({ data: { orgId, name: `PJV Programme ${stamp}` } })).id;
    const mentorId = (await seedUser(mentor, PW, 'MENTOR', `PJV Mentor ${stamp}`, orgId)).id;
    const menteeId = (await seedUser(mentee, PW, 'MENTEE', `PJV Mentee ${stamp}`, orgId)).id;
    const strangerId = (await seedUser(stranger, PW, 'MENTEE', `PJV Stranger ${stamp}`, orgId)).id;
    relationId = (await prisma.mentorshipRelation.create({
      data: { orgId, mentorId, menteeId, cohortId: programId, pipelineStatus: 'LEAD_IN', startDate: new Date(Date.now() - 10 * DAY - 60_000) },
    })).id;
    await prisma.mentorshipRelation.create({ data: { orgId, mentorId, menteeId: strangerId, cohortId: programId, pipelineStatus: 'LEAD_IN' } });
    await prisma.goal.create({ data: { relationId, title: 'Already set', createdAt: new Date(Date.now() - 8 * DAY) } });
    const publishedAt = new Date();
    const step = (key: string, data: object) =>
      prisma.programStep.create({ data: { orgId, programId, anchor: 'RELATION_START', audience: 'BOTH', action: 'NUDGE', ...data } as never }).then((s) => { ids[key] = s.id; });
    await step('now', { order: 0, offsetDays: 8, title: 'Check in on week two', publishedAt });
    await step('satisfied', { order: 1, offsetDays: 9, action: 'ASSIGN_TODO', title: 'Set a first goal', payload: { skipIf: 'goal_exists' }, publishedAt });
    await step('later', { order: 2, offsetDays: 30, milestone: 'Month two', title: 'Mid-point reflection', translations: { tr: 'Ara değerlendirme' }, publishedAt });
    await step('draft', { order: 3, offsetDays: 9, title: 'Unpublished idea' });
  });

  test.afterAll(async () => {
    await prisma.mentorshipRelation.deleteMany({ where: { orgId } });
    await prisma.programStep.deleteMany({ where: { orgId } });
    await prisma.cohort.deleteMany({ where: { orgId } });
    for (const email of [mentor, mentee, stranger]) await cleanupByEmail(email);
    await prisma.pipelineStage.deleteMany({ where: { orgId } });
    await prisma.organization.deleteMany({ where: { id: orgId } });
    await prisma.$disconnect();
  });

  test('both seats see one list with the same dates; a satisfied step shows its evidence', async ({ browser }) => {
    test.slow();
    const read = async (email: string) => {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await signInAndSettle(page, email, PW, email === mentor ? '/mentor' : '/portal');
      const res = await page.request.get(`/api/journey?relationId=${relationId}`);
      return { ctx, page, res };
    };

    const asMentee = await read(mentee);
    expect(asMentee.res.status()).toBe(200);
    const menteeBody = await asMentee.res.json();
    const byId = new Map<string, { group: string; dueAt: string | null; status: string; evidence: { condition: string; at: string | null } | null }>(
      menteeBody.steps.map((s: { id: string }) => [s.id, s]),
    );
    expect(byId.get(ids.now)).toMatchObject({ group: 'now', status: 'due' });
    expect(byId.get(ids.satisfied)).toMatchObject({ group: 'done', status: 'would_skip', evidence: { condition: 'goal_exists' } });
    expect(byId.get(ids.satisfied)?.evidence?.at).not.toBeNull();
    expect(byId.get(ids.later)).toMatchObject({ group: 'next', status: 'upcoming' });
    expect(byId.has(ids.draft)).toBe(false);
    // The onboarding checklist is the journey's first milestone, not a second list.
    expect(menteeBody.onboarding.map((o: { key: string }) => o.key)).toContain('kickoffMeeting');

    const asMentor = await read(mentor);
    const mentorBody = await asMentor.res.json();
    const dates = (b: { steps: { id: string; dueAt: string | null }[] }) => b.steps.map((s) => [s.id, s.dueAt]).sort();
    expect(dates(mentorBody)).toEqual(dates(menteeBody));

    // The mentor reads it on the mentee detail page.
    await gotoSettled(asMentor.page, `/mentor/mentees/${relationId}`);
    const view = asMentor.page.getByTestId('journey-view');
    await expect(view.getByTestId(`journey-item-${ids.now}`)).toContainText('Check in on week two', { timeout: 60_000 });
    await expect(view.getByTestId('journey-group-done').getByTestId(`journey-item-${ids.satisfied}`)).toContainText('Goal set on');

    // The mentee's portal, on a 360px phone: the card renders and nothing overflows.
    await asMentee.page.setViewportSize({ width: 360, height: 780 });
    await gotoSettled(asMentee.page, '/portal/journey');
    const card = asMentee.page.getByTestId('journey-view');
    await expect(card.getByTestId('journey-group-next').getByTestId(`journey-item-${ids.later}`)).toContainText('Mid-point reflection', { timeout: 60_000 });
    const overflow = await asMentee.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const box = await card.boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(360);

    await asMentee.ctx.close();
    await asMentor.ctx.close();
  });

  test('another relation’s journey is 403', async ({ page }) => {
    await signInAndSettle(page, stranger, PW, '/portal');
    expect((await page.request.get(`/api/journey?relationId=${relationId}`)).status()).toBe(403);
    expect((await page.request.get('/api/journey?relationId=nope')).status()).toBe(404);
  });
});
