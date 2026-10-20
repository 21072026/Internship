import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { gotoSettled, signInAndSettle } from './helpers/auth';

// The journey builder (#1853): an admin authors a step, previews it against a
// real pair, publishes it — and the preview never records or sends anything.
// Its own org with its own pipeline, so a built-in stage key is refused.

const PW = 'JourneyBuilder123!';
const DAY = 24 * 60 * 60 * 1000;

test.describe('program journey builder', () => {
  const stamp = `${Date.now()}`;
  const admin = uniqueEmail('jb-admin');
  const otherAdmin = uniqueEmail('jb-other-admin');
  const mentor = uniqueEmail('jb-mentor');
  const mentee = uniqueEmail('jb-mentee');
  let orgId = '';
  let otherOrgId = '';
  let programId = '';
  let relationId = '';

  test.beforeAll(async () => {
    orgId = (await prisma.organization.create({ data: { name: `JB Org ${stamp}`, slug: `jb-${stamp}` } })).id;
    otherOrgId = (await prisma.organization.create({ data: { name: `JB Other ${stamp}`, slug: `jb-o-${stamp}` } })).id;
    await prisma.pipelineStage.createMany({
      data: [
        { orgId, key: 'LEAD_IN', label: 'Lead in', order: 0 },
        { orgId, key: 'ON_THE_JOB', label: 'On the job', order: 1 },
      ],
    });
    programId = (await prisma.cohort.create({ data: { orgId, name: `JB Programme ${stamp}` } })).id;
    await seedUser(admin, PW, 'ADMIN', `JB Admin ${stamp}`, orgId);
    await seedUser(otherAdmin, PW, 'ADMIN', `JB Other Admin ${stamp}`, otherOrgId);
    const mentorId = (await seedUser(mentor, PW, 'MENTOR', `JB Mentor ${stamp}`, orgId)).id;
    const menteeId = (await seedUser(mentee, PW, 'MENTEE', `JB Mentee ${stamp}`, orgId)).id;
    relationId = (await prisma.mentorshipRelation.create({
      data: { orgId, mentorId, menteeId, cohortId: programId, pipelineStatus: 'LEAD_IN', startDate: new Date(Date.now() - 10 * DAY - 60_000) },
    })).id;
  });

  test.afterAll(async () => {
    await prisma.notification.deleteMany({ where: { type: { startsWith: 'programStep.' }, user: { orgId } } });
    await prisma.mentorshipRelation.deleteMany({ where: { orgId } });
    await prisma.programStep.deleteMany({ where: { orgId } });
    await prisma.cohort.deleteMany({ where: { orgId } });
    for (const email of [admin, otherAdmin, mentor, mentee]) await cleanupByEmail(email);
    await prisma.pipelineStage.deleteMany({ where: { orgId } });
    await prisma.organization.deleteMany({ where: { id: { in: [orgId, otherOrgId] } } });
    await prisma.$disconnect();
  });

  test('author → preview (records nothing) → publish → deliver; unpublish stops only the future', async ({ page }) => {
    test.slow();
    const runs = () => prisma.programStepRun.count({ where: { relationId } });
    await signInAndSettle(page, admin, PW, '/admin');
    await gotoSettled(page, `/admin/programs/${programId}/journey`);

    // Author a draft through the form.
    await page.getByTestId('journey-milestone').fill('First weeks');
    await page.getByTestId('journey-offset').fill('10');
    await page.getByTestId('journey-title-en').fill('Ten-day reflection');
    await page.getByTestId('journey-title-tr').fill('On gün değerlendirmesi');
    await page.getByTestId('journey-save').click();
    const stepList = page.getByTestId('journey-steps');
    await expect(stepList.getByText('Ten-day reflection', { exact: true })).toBeVisible();
    const step = await prisma.programStep.findFirstOrThrow({ where: { programId } });
    expect(step).toMatchObject({ orgId, offsetDays: 10, milestone: 'First weeks', publishedAt: null, translations: { en: 'Ten-day reflection', tr: 'On gün değerlendirmesi' } });

    // Preview against the real pair: the computed date, and nothing recorded.
    expect(await runs()).toBe(0);
    await page.getByTestId('journey-preview-relation').selectOption(relationId);
    await expect(page.getByTestId(`journey-preview-${step.id}`)).toHaveAttribute('data-status', 'draft');
    await page.getByTestId(`journey-toggle-${step.id}`).click();
    await expect(page.getByTestId(`journey-preview-${step.id}`)).toHaveAttribute('data-status', 'due');
    const preview = await (await page.request.get(`/api/admin/programs/${programId}/journey/preview?relationId=${relationId}`)).json();
    const rel = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: relationId } });
    expect(preview.timeline).toEqual([{ stepId: step.id, status: 'due', dueAt: new Date(rel.startDate.getTime() + 10 * DAY).toISOString(), reason: null }]);
    expect(await runs()).toBe(0);

    // The rules are the server's: a stage this org does not have, and a bad link, are refused.
    const base = { anchor: 'RELATION_START', offsetDays: 3, audience: 'BOTH', action: 'NUDGE', translations: { en: 'x' } };
    const refuse = async (body: object) => (await (await page.request.post(`/api/admin/programs/${programId}/journey`, { data: body })).json()).code;
    expect(await refuse({ ...base, anchor: 'STAGE_ENTRY', stageKey: 'INTERNSHIP_IN_PROGRESS_450' })).toBe('stage_not_in_pipeline');
    expect(await refuse({ ...base, action: 'PUBLISH_CONTENT', url: 'javascript:alert(1)' })).toBe('invalid_url');
    expect(await refuse({ ...base, translations: {} })).toBe('title_required');

    // The journey is a template a clone can copy: plain JSON, no ids, no dates.
    const journey = await (await page.request.get(`/api/admin/programs/${programId}/journey`)).json();
    expect(journey.template).toEqual([
      { order: 0, milestone: 'First weeks', anchor: 'RELATION_START', offsetDays: 10, audience: 'BOTH', action: 'NUDGE', payload: {}, title: 'Ten-day reflection', translations: { en: 'Ten-day reflection', tr: 'On gün değerlendirmesi' } },
    ]);

    // Deliver, then unpublish: the delivered run stays, and a second published-then-pulled step never goes out.
    expect((await (await page.request.get('/api/cron?job=program-journey')).json()).programJourney).toMatchObject({ delivered: 1 });
    expect((await page.request.patch(`/api/admin/programs/${programId}/journey/${step.id}`, { data: { published: false } })).status()).toBe(200);
    const second = (await (await page.request.post(`/api/admin/programs/${programId}/journey`, { data: { ...base, offsetDays: 10, translations: { en: 'Pulled step' } } })).json()).step;
    expect((await page.request.patch(`/api/admin/programs/${programId}/journey`, { data: { publish: 'all' } })).status()).toBe(200);
    expect((await page.request.patch(`/api/admin/programs/${programId}/journey/${second.id}`, { data: { published: false } })).status()).toBe(200);
    expect((await page.request.patch(`/api/admin/programs/${programId}/journey/${step.id}`, { data: { published: false } })).status()).toBe(200);
    expect((await (await page.request.get('/api/cron?job=program-journey')).json()).programJourney).toMatchObject({ delivered: 0 });
    const left = await prisma.programStepRun.findMany({ where: { relationId } });
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ stepId: step.id });
    expect(left[0].deliveredAt).not.toBeNull();
  });

  test('another tenant’s admin cannot read or write the journey', async ({ page }) => {
    await signInAndSettle(page, otherAdmin, PW, '/admin');
    expect((await page.request.get(`/api/admin/programs/${programId}/journey`)).status()).toBe(404);
    expect((await page.request.post(`/api/admin/programs/${programId}/journey`, { data: { anchor: 'RELATION_START', offsetDays: 1, audience: 'BOTH', action: 'NUDGE', translations: { en: 'x' } } })).status()).toBe(404);
    expect((await page.request.get(`/api/admin/programs/${programId}/journey/preview?relationId=${relationId}`)).status()).toBe(404);
  });
});
