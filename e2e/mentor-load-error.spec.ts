import { test, expect, type Page } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

// #1374: four mentor pages read their data with a bare `res.json()`. A 500 or
// a dropped connection never reached `setLoading(false)`, so the skeleton or
// "Loading…" spun forever and "no data" looked exactly like "something broke".
// Each page now shows an error with a retry, and the retry really reloads.

const PASSWORD = 'LoadErrorPass123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

/** Fail matching API calls until the returned function is called. */
async function failApi(page: Page, pattern: RegExp) {
  const handler = (route: import('@playwright/test').Route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' })
      : route.continue();
  await page.route(pattern, handler);
  return () => page.unroute(pattern, handler);
}

test('a failed load on the mentor pages shows an error with a retry, never an endless spinner', async ({ page }) => {
  const mentorEmail = uniqueEmail('loaderr-mentor');
  const menteeEmail = uniqueEmail('loaderr-mentee');
  const mentor = await seedUser(mentorEmail, PASSWORD, 'MENTOR', 'Load Error Mentor');
  const mentee = await seedUser(menteeEmail, 'x', 'MENTEE', 'Load Error Mentee');
  const relation = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });

  try {
    await signInAndSettle(page, mentorEmail, PASSWORD, '/mentor');

    const cases: { path: string; api: RegExp; testId: string; loaded: () => ReturnType<Page['getByText']> }[] = [
      { path: '/mentor/mentees', api: /\/api\/mentorship(\?.*)?$/, testId: 'mentees-load-error', loaded: () => page.getByText('Load Error Mentee').first() },
      { path: '/mentor/board', api: /\/api\/mentorship(\?.*)?$/, testId: 'board-load-error', loaded: () => page.getByText('Load Error Mentee').first() },
      { path: '/mentor/interactions', api: /\/api\/interactions(\?.*)?$/, testId: 'interactions-load-error', loaded: () => page.getByRole('heading').first() },
      { path: `/mentor/mentees/${relation.id}`, api: new RegExp(`/api/mentorship/${relation.id}$`), testId: 'mentee-load-error', loaded: () => page.getByText('Load Error Mentee').first() },
    ];

    for (const c of cases) {
      const restore = await failApi(page, c.api);
      await page.goto(c.path);
      const card = page.getByTestId(c.testId);
      await expect(card, c.path).toBeVisible({ timeout: 20_000 });
      await expect(card).toContainText('Something went wrong');
      await expect(page.getByTestId('page-loading')).toHaveCount(0);

      // The retry re-runs the same load; with the API healthy again the page renders.
      await restore();
      await page.getByTestId(`${c.testId}-retry`).click();
      await expect(card, `${c.path} after retry`).toHaveCount(0, { timeout: 20_000 });
      await expect(c.loaded(), `${c.path} content`).toBeVisible({ timeout: 20_000 });
    }

    // A healthy empty list still gets its empty state, not the error card.
    await prisma.mentorshipRelation.deleteMany({ where: { id: relation.id } });
    await page.goto('/mentor/interactions');
    await expect(page.getByTestId('interactions-load-error')).toHaveCount(0);
  } finally {
    await prisma.interactionLog.deleteMany({ where: { relationId: relation.id } }).catch(() => {});
    await prisma.mentorshipRelation.deleteMany({ where: { id: relation.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});
