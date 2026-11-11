import { test, expect, request as playwrightRequest } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInViaApi } from './helpers/auth';
import { dispatchDueSurveyCampaigns } from '../src/lib/surveyCampaigns';
import { hashSurveyToken } from '../src/lib/surveys';

// The close of a pairing (#1795), in its own org: the admin switches the
// close-loop survey on; the mentor ends one pairing as finished with a closure
// plan and another as "no fit"; the campaign invites BOTH sides of each; the
// mentee answers by token without a session; the report counts the finished
// pairing as the one success and the no-fit one as not a completion; the
// mentee reads the plan on their portal; neither participant reads the report.

test.afterAll(async () => prisma.$disconnect());

const PW = 'ClosurePass123!';

test('closure plan, both invitations, a token answer and the report', async ({ request, baseURL }) => {
  test.setTimeout(120_000);
  const s = `${Date.now()}-${randomBytes(3).toString('hex')}`;
  const org = await prisma.organization.create({ data: { name: `Closure ${s}`, slug: `closure-${s}` } });
  const emails = ['cl-admin', 'cl-mentor', 'cl-mentee', 'cl-mentee2'].map((p) => uniqueEmail(p));
  const [adminEmail, mentorEmail, menteeEmail, mentee2Email] = emails;
  try {
    await seedUser(adminEmail, PW, 'ADMIN', 'Closure Admin', org.id);
    const mentor = await seedUser(mentorEmail, PW, 'MENTOR', 'Closure Mentor', org.id);
    const mentee = await seedUser(menteeEmail, PW, 'MENTEE', 'Closure Mentee', org.id);
    const mentee2 = await seedUser(mentee2Email, PW, 'MENTEE', 'NoFit Mentee', org.id);
    const startDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const done = await prisma.mentorshipRelation.create({ data: { orgId: org.id, mentorId: mentor.id, menteeId: mentee.id, startDate } });
    const noFit = await prisma.mentorshipRelation.create({ data: { orgId: org.id, mentorId: mentor.id, menteeId: mentee2.id, startDate } });

    // The admin switches the close-loop survey on (idempotent).
    const admin = await playwrightRequest.newContext({ baseURL });
    expect((await signInViaApi(admin, adminEmail, PW)).ok).toBe(true);
    expect((await admin.post('/api/admin/analytics/closure')).status()).toBe(201);
    expect((await admin.post('/api/admin/analytics/closure')).status()).toBe(200);

    // The mentor ends both pairings — one with a plan.
    expect((await signInViaApi(request, mentorEmail, PW)).ok).toBe(true);
    const end1 = await request.post(`/api/mentorship/${done.id}/lifecycle`, {
      data: { to: 'COMPLETED', reasonCode: 'finished', closurePlan: 'Keep in touch quarterly; intro to the hiring manager made.' },
    });
    expect(end1.ok()).toBeTruthy();
    expect((await request.post(`/api/mentorship/${noFit.id}/lifecycle`, { data: { to: 'ENDED_EARLY', reasonCode: 'no_fit' } })).ok()).toBeTruthy();
    expect((await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: done.id } })).closurePlan).toContain('Keep in touch quarterly');

    // Neither participant reads the report.
    expect((await request.get('/api/admin/analytics/closure')).status()).toBe(403);

    // The campaign invites BOTH sides of each ended pairing, once.
    await dispatchDueSurveyCampaigns(new Date(), { orgIds: [org.id] });
    await dispatchDueSurveyCampaigns(new Date(), { orgIds: [org.id] });
    const sends = await prisma.surveyCampaignSend.findMany({ where: { relationId: { in: [done.id, noFit.id] } }, select: { relationId: true, userId: true, invitationId: true } });
    expect(sends.filter((x) => x.relationId === done.id).map((x) => x.userId).sort()).toEqual([mentor.id, mentee.id].sort());
    expect(sends.filter((x) => x.relationId === noFit.id)).toHaveLength(2);

    // The mentee answers from the mail, signed out: the token is the credential.
    const invitationId = sends.find((x) => x.relationId === done.id && x.userId === mentee.id)!.invitationId!;
    const token = randomBytes(24).toString('base64url');
    await prisma.surveyInvitation.update({ where: { id: invitationId }, data: { tokenHash: hashSurveyToken(token) } });
    const anon = await playwrightRequest.newContext({ baseURL });
    try {
      const answered = await anon.post('/api/surveys/respond', { data: { token, answers: { overall: 5, goals_met: 4, nps: 10, comment: 'It worked.' } } });
      expect((await answered.json()).state).toBe('answered');
      const replay = await anon.post('/api/surveys/respond', { data: { token, answers: { overall: 1, goals_met: 1, nps: 0 } } });
      expect((await replay.json()).state).toBe('alreadyAnswered');
    } finally {
      await anon.dispose();
    }

    // The report: two endings, ONE success; the no-fit one is not a completion.
    const res = await admin.get('/api/admin/analytics/closure');
    expect(res.ok()).toBeTruthy();
    const report = await res.json();
    expect(report.relations).toBe(2);
    expect(report.successes).toBe(1);
    expect(report.invited).toBe(4);
    expect(report.responses).toBe(1);
    const noFitGroup = report.groups.find((g: { reasonCode: string | null }) => g.reasonCode === 'no_fit');
    expect(noFitGroup).toMatchObject({ outcome: 'ended_early', success: false, relations: 1 });
    // One answer is under the floor: no scores are shown for it.
    expect(report.groups.find((g: { outcome: string }) => g.outcome === 'completed').scores).toBeNull();
    expect(report.setup).toMatchObject({ status: 'OPEN', campaignActive: true });
    await admin.dispose();

    // The mentee reads the plan on their archived pairing.
    const mentee1 = await playwrightRequest.newContext({ baseURL });
    try {
      expect((await signInViaApi(mentee1, menteeEmail, PW)).ok).toBe(true);
      const portal = await mentee1.get('/portal');
      expect(await portal.text()).toContain('Keep in touch quarterly');
      expect((await mentee1.get('/api/admin/analytics/closure')).status()).toBe(403);
    } finally {
      await mentee1.dispose();
    }
  } finally {
    for (const e of emails) await cleanupByEmail(e);
    await prisma.survey.deleteMany({ where: { orgId: org.id } });
    await prisma.organization.deleteMany({ where: { id: org.id } }).catch(() => {});
  }
});
