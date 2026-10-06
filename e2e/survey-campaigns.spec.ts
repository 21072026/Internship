import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';
import { createSurvey } from '../src/lib/surveys';

// Survey campaigns (#1887). Its own org, WITH ITS OWN PIPELINE — the stage the
// campaign listens for is a custom key the built-in catalogue does not have,
// so a hardcoded stage key could never make this pass.
//   • two sweeps in a row → one claim, one invitation, one mail per person;
//   • someone who switched the `surveys` e-mail group off is never claimed;
//   • one tick sends no more than the cap, the rest go on the next tick;
//   • a RECURRING pulse sends one invitation per person per ROUND (#2769).

const PW = 'SurveyCampaigns123!';

test.describe('survey campaigns', () => {
  const stamp = `${Date.now()}`;
  const admin = uniqueEmail('sc2-admin');
  const mentor = uniqueEmail('sc2-mentor');
  const mentees = [0, 1, 2, 3].map((i) => uniqueEmail(`sc2-mentee-${i}`));
  let orgId = '';
  let surveyId = '';
  const ids: string[] = [];
  const relationIds: string[] = [];

  test.beforeAll(async () => {
    orgId = (await prisma.organization.create({ data: { name: `SC2 Org ${stamp}`, slug: `sc2-${stamp}` } })).id;
    // The org's own pipeline: three stages, none of them built-in keys.
    await prisma.pipelineStage.createMany({
      data: [
        { orgId, key: 'LEAD_IN', label: 'Lead in', order: 0 },
        { orgId, key: 'OFFER_SIGNED', label: 'Offer signed', order: 1 },
        { orgId, key: 'ONBOARDED', label: 'Onboarded', order: 2, isTerminal: true },
      ],
    });
    await seedUser(admin, PW, 'ADMIN', `SC2 Admin ${stamp}`, orgId);
    const m = await seedUser(mentor, PW, 'MENTOR', `SC2 Mentor ${stamp}`, orgId);
    for (const [i, email] of mentees.entries()) {
      const id = (await seedUser(email, PW, 'MENTEE', `SC2 Mentee ${i} ${stamp}`, orgId)).id;
      ids.push(id);
      relationIds.push((await prisma.mentorshipRelation.create({ data: { orgId, mentorId: m.id, menteeId: id, pipelineStatus: 'LEAD_IN' } })).id);
    }
    // Mentee 3 switched survey mail off.
    await prisma.user.update({ where: { id: ids[3] }, data: { notificationPrefs: { 'email:surveys': false } } });
    const survey = await createSurvey(orgId, {
      key: 'offer_pulse',
      title: { en: 'How did the offer stage go?' },
      audience: 'MENTEE',
      anonymity: 'CONFIDENTIAL',
      questions: [{ key: 'nps', type: 'NPS', labels: { en: 'Would you recommend us?' }, required: true }],
    });
    surveyId = survey.id;
    await prisma.survey.update({ where: { id: surveyId }, data: { status: 'OPEN' } });
  });

  test.afterAll(async () => {
    await prisma.emailLog.deleteMany({ where: { to: { in: mentees } } });
    await prisma.survey.deleteMany({ where: { orgId } });
    await prisma.mentorshipRelation.deleteMany({ where: { orgId } });
    for (const email of [admin, mentor, ...mentees]) await cleanupByEmail(email);
    await prisma.organization.deleteMany({ where: { id: orgId } });
    await prisma.$disconnect();
  });

  test('a custom-stage trigger fires once per person across two sweeps, and opt-outs are never claimed', async ({ page }) => {
    await signInAndSettle(page, admin, PW, '/admin');
    // A pulse without its interval is refused.
    expect((await page.request.post('/api/admin/survey-campaigns', { data: { surveyId, name: 'Pulse', trigger: 'RECURRING' } })).status()).toBe(400);
    // A key the org does not have is refused — it would silently never fire.
    const bogus = await page.request.post('/api/admin/survey-campaigns', { data: { surveyId, name: 'Bogus', trigger: 'STAGE_ENTERED', stageKey: 'INTERNSHIP_COMPLETED_490' } });
    expect(bogus.status()).toBe(400);
    const created = await page.request.post('/api/admin/survey-campaigns', { data: { surveyId, name: 'Offer signed', trigger: 'STAGE_ENTERED', stageKey: 'OFFER_SIGNED' } });
    expect(created.status()).toBe(201);
    const campaignId = (await created.json()).campaign.id;

    // Mentees 0, 1 and 3 enter the custom stage; mentee 2 does not.
    for (const i of [0, 1, 3]) {
      await prisma.statusChange.create({ data: { relationId: relationIds[i], fromStatus: 'LEAD_IN', toStatus: 'OFFER_SIGNED' } });
    }

    const first = (await (await page.request.get('/api/cron?job=surveys')).json()).surveys;
    expect(first).toMatchObject({ sent: 2, skipped: 1 });
    const second = (await (await page.request.get('/api/cron?job=surveys')).json()).surveys;
    expect(second.sent).toBe(0);

    const sends = await prisma.surveyCampaignSend.findMany({ where: { campaignId }, orderBy: { userId: 'asc' } });
    expect(sends.map((s) => s.userId).sort()).toEqual([ids[0], ids[1]].sort());
    expect(sends.every((s) => s.periodKey === 'stage:OFFER_SIGNED' && s.invitationId)).toBe(true);
    expect(await prisma.surveyInvitation.count({ where: { surveyId } })).toBe(2);
    expect(await prisma.emailLog.count({ where: { to: { in: mentees }, category: 'survey-invite' } })).toBe(2);
    // The opted-out mentee: no claim, no invitation, no mail.
    expect(await prisma.surveyInvitation.count({ where: { surveyId, userId: ids[3] } })).toBe(0);
    expect(await prisma.emailLog.count({ where: { to: mentees[3], category: 'survey-invite' } })).toBe(0);
    await page.request.patch(`/api/admin/survey-campaigns/${campaignId}`, { data: { active: false } });
  });

  test('one tick sends no more than the cap; the rest go out on the next tick', async ({ page }) => {
    await signInAndSettle(page, admin, PW, '/admin');
    const second = await createSurvey(orgId, {
      key: 'kickoff',
      title: { en: 'Kick-off survey' },
      audience: 'MENTEE',
      anonymity: 'ANONYMOUS',
      questions: [{ key: 'ready', type: 'BOOLEAN', labels: { en: 'Do you feel ready?' }, required: true }],
    });
    await prisma.survey.update({ where: { id: second.id }, data: { status: 'OPEN' } });
    const campaignId = (await (await page.request.post('/api/admin/survey-campaigns', { data: { surveyId: second.id, name: 'Everyone, once', trigger: 'MANUAL' } })).json()).campaign.id;

    // Three reachable mentees (the fourth opted out), a cap of two.
    const tick1 = (await (await page.request.get('/api/cron?job=surveys&batch=2')).json()).surveys;
    expect(tick1).toMatchObject({ sent: 2, deferred: 1 });
    const tick2 = (await (await page.request.get('/api/cron?job=surveys&batch=2')).json()).surveys;
    expect(tick2).toMatchObject({ sent: 1, deferred: 0 });
    expect(await prisma.surveyCampaignSend.count({ where: { campaignId } })).toBe(3);
    // A batch above the cap is clamped, never raised.
    expect((await (await page.request.get('/api/cron?job=surveys&batch=500')).json()).surveys.sent).toBe(0);
    await page.request.patch(`/api/admin/survey-campaigns/${campaignId}`, { data: { active: false } });
  });

  test('a recurring pulse invites each person once per round, and each round only once', async ({ page }) => {
    await signInAndSettle(page, admin, PW, '/admin');
    const pulse = await createSurvey(orgId, {
      key: 'weekly_pulse',
      title: { en: 'Weekly pulse' },
      audience: 'MENTEE',
      anonymity: 'ANONYMOUS',
      questions: [{ key: 'mood', type: 'SCALE', labels: { en: 'How is it going?' }, required: true }],
    });
    await prisma.survey.update({ where: { id: pulse.id }, data: { status: 'OPEN' } });
    const created = await page.request.post('/api/admin/survey-campaigns', { data: { surveyId: pulse.id, name: 'Weekly', trigger: 'RECURRING', everyDays: 7 } });
    expect(created.status()).toBe(201);
    const campaignId = (await created.json()).campaign.id;

    const day = 24 * 60 * 60 * 1000;
    const sweep = async (offsetDays: number) =>
      (await (await page.request.get(`/api/cron?job=surveys&at=${new Date(Date.now() + offsetDays * day).toISOString()}`)).json()).surveys;
    // Round 0, twice: three reachable mentees (the fourth opted out), once each.
    expect((await sweep(0)).sent).toBe(3);
    expect((await sweep(0)).sent).toBe(0);
    // Round 1 a week later — a second invitation per person, which the old
    // [surveyId, email] unique could not hold — and again only once.
    expect((await sweep(7)).sent).toBe(3);
    expect((await sweep(8)).sent).toBe(0);

    const invitations = await prisma.surveyInvitation.findMany({ where: { surveyId: pulse.id }, select: { userId: true, round: true } });
    expect(invitations).toHaveLength(6);
    for (const id of ids.slice(0, 3)) {
      expect(invitations.filter((i) => i.userId === id).map((i) => i.round).sort()).toEqual(['pulse:0', 'pulse:1']);
    }
    expect(invitations.some((i) => i.userId === ids[3])).toBe(false);
    expect(await prisma.surveyCampaignSend.count({ where: { campaignId } })).toBe(6);
  });
});
