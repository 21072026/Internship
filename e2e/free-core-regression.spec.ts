import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function signIn(page: import('@playwright/test').Page, email: string, pw: string, home: string) {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', pw);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => u.pathname.startsWith(home), { timeout: 20_000 });
}

// #526 — regression shield for the "mentor & mentee are always free" principle:
// with ZERO premium entitlements anywhere (none are created here; nothing is on
// by default), every core mentor/mentee flow must keep working. If a future
// change accidentally gates a core route behind hasFeature(), this fails.
test('core mentor/mentee flows work with no premium entitlement anywhere', async ({ browser }) => {
  const mentorEmail = uniqueEmail('freecore-mentor');
  const menteeEmail = uniqueEmail('freecore-mentee');
  const pw = 'FreeCorePass123';
  const mentor = await seedUser(mentorEmail, pw, 'MENTOR', 'FreeCore Mentor');
  const mentee = await seedUser(menteeEmail, pw, 'MENTEE', 'FreeCore Mentee');
  const rel = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, status: 'ACTIVE' },
  });

  const mentorCtx = await browser.newContext();
  const menteeCtx = await browser.newContext();

  try {
    // ---- Mentor side ----
    const mentorPage = await mentorCtx.newPage();
    await signIn(mentorPage, mentorEmail, pw, '/mentor');

    // Profile loads.
    expect((await mentorPage.request.get('/api/profile')).ok()).toBeTruthy();

    // Goals: create one for the mentee.
    const goal = await mentorPage.request.post('/api/goals', {
      data: { relationId: rel.id, title: 'Ship the demo project' },
    });
    expect(goal.ok()).toBeTruthy();

    // Interaction log.
    const interaction = await mentorPage.request.post('/api/interactions', {
      data: { relationId: rel.id, date: new Date().toISOString(), notes: 'Weekly sync', type: 'Meeting' },
    });
    expect(interaction.ok()).toBeTruthy();

    // Messaging.
    const message = await mentorPage.request.post('/api/messages', {
      data: { relationId: rel.id, body: 'Welcome aboard!' },
    });
    expect(message.ok()).toBeTruthy();

    // Structured evaluation of the mentee.
    const evaluation = await mentorPage.request.post('/api/evaluations', {
      data: { relationId: rel.id, type: 'INTERIM', scores: { technical: 4, communication: 5 }, comment: 'Solid start.' },
    });
    expect(evaluation.ok()).toBeTruthy();

    // Notifications endpoint (bell) responds.
    expect((await mentorPage.request.get('/api/notifications')).ok()).toBeTruthy();

    // ---- Mentee side ----
    const menteePage = await menteeCtx.newPage();
    await signIn(menteePage, menteeEmail, pw, '/portal');

    // Portal profile loads and the mentee can ask their mentor a question.
    expect((await menteePage.request.get('/api/profile')).ok()).toBeTruthy();
    const question = await menteePage.request.post('/api/questions', {
      data: { relationId: rel.id, question: 'What should I focus on first?' },
    });
    expect(question.ok()).toBeTruthy();

    // The mentee sees the mentor's message thread.
    const thread = await menteePage.request.get(`/api/messages?relationId=${rel.id}`);
    expect(thread.ok()).toBeTruthy();

    // Sanity: none of the above created or needed an entitlement row for these
    // users (nothing is on by default — the free core ran entitlement-free).
    // Scoped check: no company/entitlement is attached to this relation.
    const relAfter = await prisma.mentorshipRelation.findUnique({ where: { id: rel.id }, select: { companyId: true } });
    expect(relAfter!.companyId).toBeNull();
  } finally {
    await mentorCtx.close();
    await menteeCtx.close();
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeEmail);
  }
});
