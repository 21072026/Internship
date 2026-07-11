import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// Faz 2 (#534): the interaction-log AI summary is gated by the MENTEE's
// AI_INTERACTION_SUMMARY consent, then the shared AI gate (quota → provider).
// CI has no provider key, so consent-granted requests stop at 501 — asserting
// the gates without a real AI call.
test('interaction summary requires mentee consent, then passes to the AI gate', async ({ browser }) => {
  const mentorEmail = uniqueEmail('sum-mentor');
  const menteeEmail = uniqueEmail('sum-mentee');
  const pw = 'SummaryPass123';
  const mentor = await seedUser(mentorEmail, pw, 'MENTOR', 'Summary Mentor');
  const mentee = await seedUser(menteeEmail, pw, 'MENTEE', 'Summary Mentee');
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });
  await prisma.interactionLog.create({
    data: { relationId: rel.id, type: 'Meeting', notes: 'Discussed project architecture.', date: new Date() },
  });

  const mentorCtx = await browser.newContext();
  const menteeCtx = await browser.newContext();
  try {
    const mentorPage = await mentorCtx.newPage();
    await mentorPage.goto('/auth/signin');
    await mentorPage.fill('input[type="email"], input[name="email"]', mentorEmail);
    await mentorPage.fill('input[type="password"]', pw);
    await mentorPage.click('button[type="submit"]');
    await mentorPage.waitForURL((u) => u.pathname.startsWith('/mentor'), { timeout: 20_000 });

    // Mentee hasn't consented → 403 with a consent code.
    let res = await mentorPage.request.post('/api/interactions/summary', { data: { relationId: rel.id } });
    expect(res.status()).toBe(403);
    expect((await res.json()).code).toBe('consent_required');

    // Mentee grants the consent.
    const menteePage = await menteeCtx.newPage();
    await menteePage.goto('/auth/signin');
    await menteePage.fill('input[type="email"], input[name="email"]', menteeEmail);
    await menteePage.fill('input[type="password"]', pw);
    await menteePage.click('button[type="submit"]');
    await menteePage.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });
    await menteePage.request.post('/api/consent', { data: { type: 'AI_INTERACTION_SUMMARY', granted: true } });

    // Now the request passes consent and quota, stopping at the provider (no
    // key in CI → 501) — and no credit was consumed by the failure.
    const usageBefore = await prisma.aiUsage.count();
    res = await mentorPage.request.post('/api/interactions/summary', { data: { relationId: rel.id } });
    expect(res.status()).toBe(501);
    expect((await res.json()).code).toBe('not_configured');
    expect(await prisma.aiUsage.count()).toBe(usageBefore);

    // The summary button renders on the mentee detail page.
    await mentorPage.goto(`/mentor/mentees/${rel.id}`);
    await expect(mentorPage.getByTestId('interaction-summary')).toBeVisible({ timeout: 10_000 });
  } finally {
    await mentorCtx.close();
    await menteeCtx.close();
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});
