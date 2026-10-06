import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';
import { freshIp } from './helpers/rateLimit';
import { createSurvey, submitSurveyResponse } from '../src/lib/surveys';
import { createSurveyInvitation, mintInvitationReminderToken } from '../src/lib/surveyTokens';

// Survey reminders and the completion console (#1889). Its own org.
//   • two reminders (day 3, day 7) and never a third — not by the schedule, not
//     by "remind now";
//   • one claim for both paths: two clicks at once send one reminder, and a
//     manual nudge moves the schedule along instead of adding to it;
//   • every link works: the first mail's and each reminder's;
//   • an ANONYMOUS survey's completion payload names nobody, and the rate is
//     not shown below the floor;
//   • a mentor and a mentee get 403 from both routes.

const PW = 'SurveyCompletion123!';
const DAY = 24 * 60 * 60 * 1000;
const QUESTIONS: Parameters<typeof createSurvey>[1]['questions'] = [
  { key: 'nps', type: 'NPS', labels: { en: 'Would you recommend the programme?' }, required: true },
];

test.describe('survey completion', () => {
  const stamp = `${Date.now()}`;
  const admin = uniqueEmail('scp-admin');
  const mentor = uniqueEmail('scp-mentor');
  const mentees = [0, 1, 2].map((i) => uniqueEmail(`scp-mentee-${i}`));
  const external = [0, 1, 2, 3, 4, 5].map((i) => uniqueEmail(`scp-ext-${i}`));
  let orgId = '';
  const menteeIds: string[] = [];

  const openSurvey = async (key: string, anonymity: 'IDENTIFIED' | 'CONFIDENTIAL' | 'ANONYMOUS') => {
    const survey = await createSurvey(orgId, { key, title: { en: `Survey ${key} ${stamp}` }, audience: 'MENTEE', anonymity, questions: QUESTIONS });
    await prisma.survey.update({ where: { id: survey.id }, data: { status: 'OPEN' } });
    return survey.id;
  };
  const invite = async (surveyId: string, email: string, userId?: string) => (await createSurveyInvitation({ surveyId, orgId, email, userId }))!;
  const sweep = async (page: import('@playwright/test').Page, offsetDays: number) =>
    (await (await page.request.get(`/api/cron?job=surveys&at=${new Date(Date.now() + offsetDays * DAY).toISOString()}`)).json()).surveyReminders;

  test.beforeAll(async () => {
    orgId = (await prisma.organization.create({ data: { name: `SCP Org ${stamp}`, slug: `scp-${stamp}` } })).id;
    await seedUser(admin, PW, 'ADMIN', `SCP Admin ${stamp}`, orgId);
    await seedUser(mentor, PW, 'MENTOR', `SCP Mentor ${stamp}`, orgId);
    for (const [i, email] of mentees.entries()) menteeIds.push((await seedUser(email, PW, 'MENTEE', `SCP Mentee ${i} ${stamp}`, orgId)).id);
  });

  test.afterAll(async () => {
    await prisma.emailLog.deleteMany({ where: { to: { in: [...mentees, ...external] } } });
    await prisma.survey.deleteMany({ where: { orgId } });
    for (const email of [admin, mentor, ...mentees]) await cleanupByEmail(email);
    await prisma.organization.deleteMany({ where: { id: orgId } });
    await prisma.$disconnect();
  });

  test('two reminders on schedule, never a third, and every link still answers', async ({ page }) => {
    const surveyId = await openSurvey('cap', 'CONFIDENTIAL');
    const invites = await Promise.all(mentees.map((email, i) => invite(surveyId, email, menteeIds[i])));
    // Mentee 2 answers straight away and is never reminded.
    await submitSurveyResponse({ surveyId, invitationId: invites[2].invitationId, respondentId: menteeIds[2], respondentRole: 'MENTEE', answers: { nps: 9 } });

    await signInAndSettle(page, admin, PW, '/admin');
    expect(await sweep(page, 1)).toMatchObject({ sent: 0 }); // not due before day 3
    expect(await sweep(page, 3)).toMatchObject({ sent: 2 });
    expect(await sweep(page, 3)).toMatchObject({ sent: 0 }); // claimed
    expect(await sweep(page, 5)).toMatchObject({ sent: 0 }); // the second waits for day 7
    expect(await sweep(page, 7)).toMatchObject({ sent: 2 });
    expect(await sweep(page, 20)).toMatchObject({ sent: 0 }); // the cap

    // "Remind now" cannot be the third one either.
    const manual = (await (await page.request.post(`/api/admin/surveys/${surveyId}/remind`, { data: {} })).json()).result;
    expect(manual).toMatchObject({ sent: 0, refused: { cap: 2 } });

    const rows = await prisma.surveyInvitation.findMany({ where: { surveyId }, include: { _count: { select: { tokens: true } } } });
    for (const i of [0, 1]) {
      const row = rows.find((r) => r.id === invites[i].invitationId)!;
      expect(row.remindersSent).toBe(2);
      expect(row._count.tokens).toBe(2); // one new link per reminder
    }
    expect(rows.find((r) => r.id === invites[2].invitationId)!.remindersSent).toBe(0);
    expect(await prisma.emailLog.count({ where: { to: { in: mentees.slice(0, 2) }, category: 'survey-invite' } })).toBe(4);

    // The first mail's link and a reminder's link both open the same invitation.
    const reminderToken = await mintInvitationReminderToken(invites[0].invitationId);
    for (const token of [invites[0].token, reminderToken]) {
      const res = await page.request.get(`/api/surveys/respond?token=${token}`, { headers: freshIp('survey-completion') });
      expect((await res.json()).state).toBe('open');
    }
  });

  test('one claim for both paths: concurrent clicks send one, a manual nudge moves the schedule along', async ({ page }) => {
    const surveyId = await openSurvey('claim', 'IDENTIFIED');
    const [a, b] = await Promise.all([invite(surveyId, mentees[0], menteeIds[0]), invite(surveyId, mentees[1], menteeIds[1])]);
    await signInAndSettle(page, admin, PW, '/admin');

    const remindA = () => page.request.post(`/api/admin/surveys/${surveyId}/remind`, { data: { invitationIds: [a.invitationId] } }).then((r) => r.json());
    const [r1, r2] = await Promise.all([remindA(), remindA()]);
    expect(r1.result.sent + r2.result.sent).toBe(1);
    // Within 24 hours of the last one, another click is refused.
    expect((await remindA()).result).toMatchObject({ sent: 0, refused: { too_soon: 1 } });

    // Day 3: only b's first is due — a already had its first, its second waits for day 7.
    expect(await sweep(page, 3)).toMatchObject({ sent: 1 });
    expect(await sweep(page, 7)).toMatchObject({ sent: 2 });
    const counts = await prisma.surveyInvitation.findMany({ where: { surveyId }, select: { id: true, remindersSent: true } });
    expect(counts.map((c) => c.remindersSent)).toEqual([2, 2]);
    expect(counts.map((c) => c.id).sort()).toEqual([a.invitationId, b.invitationId].sort());

    // The console lists the two non-responders, each at the cap.
    const completion = (await (await page.request.get(`/api/admin/surveys/${surveyId}/completion`)).json()).completion;
    expect(completion.pending.map((p: { cannotRemind: string }) => p.cannotRemind)).toEqual(['cap', 'cap']);
    await page.goto(`/admin/surveys/${surveyId}`);
    await expect(page.getByTestId(`cannot-remind-${a.invitationId}`)).toBeVisible();
  });

  test('an anonymous survey names nobody; the rate appears only at the floor', async ({ page }) => {
    const surveyId = await openSurvey('anon', 'ANONYMOUS');
    const invites = [];
    for (const email of external) invites.push(await invite(surveyId, email));
    for (const inv of invites.slice(0, 4)) {
      await submitSurveyResponse({ surveyId, invitationId: inv.invitationId, respondentRole: 'MENTEE', answers: { nps: 8 } });
    }
    await signInAndSettle(page, admin, PW, '/admin');
    const get = async () => {
      const res = await page.request.get(`/api/admin/surveys/${surveyId}/completion`);
      expect(res.status()).toBe(200);
      return { body: await res.text(), completion: (await res.json()).completion };
    };

    const under = await get();
    expect(under.completion).toMatchObject({ invited: 6, responded: null, rate: null, pending: null, pendingByReminders: [2, 0, 0] });
    // Asserted on the payload, not the DOM: no address, no invitation id.
    for (const email of external) expect(under.body).not.toContain(email);
    for (const inv of invites) expect(under.body).not.toContain(inv.invitationId);

    await submitSurveyResponse({ surveyId, invitationId: invites[4].invitationId, respondentRole: 'MENTEE', answers: { nps: 10 } });
    expect((await get()).completion).toMatchObject({ responded: 5, rate: 83, pending: null });

    // Naming an invitation is refused; the whole-survey nudge is the only form.
    const named = await page.request.post(`/api/admin/surveys/${surveyId}/remind`, { data: { invitationIds: [invites[5].invitationId] } });
    expect(named.status()).toBe(400);
    expect((await (await page.request.post(`/api/admin/surveys/${surveyId}/remind`, { data: {} })).json()).result.sent).toBe(1);

    await page.goto(`/admin/surveys/${surveyId}`);
    await expect(page.getByTestId('completion-anonymous')).toBeVisible();
    await expect(page.getByTestId('completion-pending')).toHaveCount(0);
  });

  test('a mentor and a mentee are refused by both routes', async ({ page }) => {
    const surveyId = await openSurvey('authz', 'IDENTIFIED');
    for (const [email, landing] of [[mentor, '/mentor'], [mentees[0], '/portal']] as const) {
      await page.context().clearCookies();
      await signInAndSettle(page, email, PW, landing);
      expect((await page.request.get(`/api/admin/surveys/${surveyId}/completion`)).status()).toBe(403);
      expect((await page.request.post(`/api/admin/surveys/${surveyId}/remind`, { data: {} })).status()).toBe(403);
    }
  });
});
