import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #2040 — the matching feedback loop. Every suggestion we put in front of an
// admin is recorded (SHOWN), and what the admin does with it overwrites that
// row in place (DISMISSED with a reason, or ACCEPTED) so the rank it was shown
// at survives and "does our #1 actually get picked?" stays answerable.
//
// Locator notes (CLAUDE.md): /admin/candidates renders every candidate twice
// (md:hidden mobile list + desktop grid), so everything below is scoped to the
// desktop card testid; and the dismiss reason picker adds a SECOND <select> to
// that card, hence the data-testid rather than card.locator('select').

async function signInAsAdmin(page: import('@playwright/test').Page, email: string, pw: string) {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', pw);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });
}

test('dismissing a mentor suggestion records the reason and reveals the next-best mentor', async ({ page }) => {
  const stamp = `${Date.now()}`;
  const adminEmail = uniqueEmail('mf-admin');
  const topEmail = uniqueEmail('mf-top');
  const nextEmail = uniqueEmail('mf-next');
  const menteeEmail = uniqueEmail('mf-mentee');
  const pw = 'MatchFeedback123';
  // Two unique skills so the ranking of these two mentors is deterministic and
  // no data seeded in parallel can overlap with the mentee.
  const skillA = `ElixirLang${stamp}`;
  const skillB = `ErlangVm${stamp}`;

  await seedUser(adminEmail, pw, 'ADMIN', 'MF Admin');
  const top = await seedUser(topEmail, pw, 'MENTOR', 'MF Top Mentor');
  const next = await seedUser(nextEmail, pw, 'MENTOR', 'MF Next Mentor');
  const mentee = await seedUser(menteeEmail, pw, 'MENTEE', 'MF Mentee');

  // Two shared skills beats one → `top` is rank 1, `next` is rank 2.
  await prisma.user.update({ where: { id: top.id }, data: { skills: [skillA, skillB], mentorCapacity: 5 } });
  await prisma.user.update({ where: { id: next.id }, data: { skills: [skillA], mentorCapacity: 5 } });
  await prisma.user.update({ where: { id: mentee.id }, data: { skills: [skillA, skillB] } });

  try {
    await signInAsAdmin(page, adminEmail, pw);
    await page.goto('/admin/candidates');
    const card = page.getByTestId('candidates-desktop-list').getByTestId(`candidate-card-${mentee.id}`);
    await expect(card).toBeVisible({ timeout: 15_000 });

    // Ask for suggestions. Every returned suggestion must land as a SHOWN row.
    await card.getByTestId('suggest-mentor').click();
    await expect(card.getByTestId('mentor-suggestion')).toContainText('MF Top Mentor', { timeout: 15_000 });

    let batchId = '';
    await expect(async () => {
      const rows = await prisma.matchFeedback.findMany({
        where: { menteeId: mentee.id },
        orderBy: { rank: 'asc' },
      });
      expect(rows.length).toBeGreaterThanOrEqual(2);
      expect(rows[0].mentorId).toBe(top.id);
      expect(rows[0].rank).toBe(1);
      expect(rows[0].action).toBe('SHOWN');
      // The score the rule set ranked by (shared-skill count) is stored too.
      expect(rows[0].score).toBe(2);
      expect(rows[0].ruleSetVersion).toBe('rules-v1');
      expect(rows[1].mentorId).toBe(next.id);
      expect(rows[1].rank).toBe(2);
      // One batch id for the whole call, echoed to the client.
      expect(new Set(rows.map((r) => r.batchId)).size).toBe(1);
      batchId = rows[0].batchId;
    }).toPass({ timeout: 15_000 });

    // Dismiss rank 1 with a reason.
    await card.getByTestId('dismiss-suggestion').click();
    await expect(card.getByTestId('dismiss-reason-picker')).toBeVisible();
    await card.getByTestId('dismiss-reason-select').selectOption('LANGUAGE');
    await card.getByTestId('dismiss-confirm').click();

    // The dismissal upgrades the SHOWN row in place — the rank it was shown at
    // is preserved, which is the whole point of the per-position report.
    await expect(async () => {
      const row = await prisma.matchFeedback.findUnique({
        where: { batchId_mentorId: { batchId, mentorId: top.id } },
      });
      expect(row?.action).toBe('DISMISSED');
      expect(row?.reason).toBe('LANGUAGE');
      expect(row?.rank).toBe(1);
      expect(row?.actorId).toBeTruthy();
    }).toPass({ timeout: 15_000 });

    // …and the next-best mentor takes its place on the card.
    await expect(card.getByTestId('mentor-suggestion')).toContainText('MF Next Mentor');

    // Accepting that one records ACCEPTED against the rank it was shown at.
    await card.getByRole('button', { name: 'Assign', exact: true }).click();
    await expect(async () => {
      const row = await prisma.matchFeedback.findUnique({
        where: { batchId_mentorId: { batchId, mentorId: next.id } },
      });
      expect(row?.action).toBe('ACCEPTED');
      expect(row?.rank).toBe(2);
    }).toPass({ timeout: 15_000 });
  } finally {
    await prisma.matchFeedback.deleteMany({ where: { menteeId: mentee.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { menteeId: mentee.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(topEmail);
    await cleanupByEmail(nextEmail);
    await cleanupByEmail(adminEmail);
  }
});

// Authorization lives in the handler, not in whether the control is rendered.
test('the match-feedback and match-quality routes reject non-admins at the route level', async ({ page }) => {
  const mentorEmail = uniqueEmail('mf-403-mentor');
  const pw = 'MatchFeedback123';
  await seedUser(mentorEmail, pw, 'MENTOR', 'MF 403 Mentor');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', mentorEmail);
    await page.fill('input[type="password"]', pw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/mentor'), { timeout: 20_000 });

    const feedback = await page.request.post('/api/admin/mentor-suggest/feedback', {
      data: { batchId: 'nope', mentorId: 'nope', action: 'DISMISSED', reason: 'OTHER' },
    });
    expect(feedback.status()).toBe(403);

    const report = await page.request.get('/api/admin/analytics/match-quality');
    expect(report.status()).toBe(403);
  } finally {
    await cleanupByEmail(mentorEmail);
  }
});
