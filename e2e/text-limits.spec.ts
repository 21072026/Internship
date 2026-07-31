import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

/**
 * Regression cover for the character counter (#782) and — more importantly —
 * for the invariant it was supposed to enforce: a value the UI says fits must
 * actually be storable.
 *
 * Every one of these tests fails on the code as it shipped in 0.25.11-beta:
 * the counter was absent from the Announcements box entirely, and three columns
 * were still VARCHAR(191) while their forms offered 1 000-5 000 characters, so
 * a normal-length paragraph produced a 500 (Prisma P2000) *after* the user had
 * finished typing. The existing specs all used short strings — 'Weekly sync',
 * `E2E announcement ${…}` — so none of it was reachable from CI.
 */

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function signIn(page: import('@playwright/test').Page, email: string, password: string) {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });
}

// The @smoke one: this is the assertion that would have caught the VARCHAR(191)
// bugs, and it guards the whole "UI limit is honoured by the write" invariant on
// the app's most-used free-text field.
test(
  'a long interaction note (past the old 191-char column) actually persists',
  { tag: '@smoke' },
  async ({ page }) => {
    const adminEmail = uniqueEmail('limits-admin');
    const mentorEmail = uniqueEmail('limits-mentor');
    const menteeEmail = uniqueEmail('limits-mentee');
    await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Limits Admin');
    const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Limits Mentor');
    const mentee = await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'Limits Mentee');
    const relation = await prisma.mentorshipRelation.create({
      data: { mentorId: mentor.id, menteeId: mentee.id },
    });
    // 1 200 characters: comfortably past VARCHAR(191), comfortably under the
    // 5 000 the form and the API both advertise.
    const longNote = 'Görüşme notu — '.repeat(80).slice(0, 1200);

    try {
      await signIn(page, adminEmail, 'AdminPass123');

      // page.request shares the signed-in cookie jar.
      const res = await page.request.post('/api/interactions', {
        data: {
          relationId: relation.id,
          date: new Date().toISOString(),
          notes: longNote,
          type: 'Meeting',
        },
      });
      expect(res.status(), await res.text()).toBe(201);

      const stored = await prisma.interactionLog.findFirst({ where: { relationId: relation.id } });
      expect(stored?.notes).toBe(longNote);
      expect(stored?.notes.length).toBe(1200);
    } finally {
      await prisma.interactionLog.deleteMany({ where: { relationId: relation.id } });
      await prisma.mentorshipRelation.deleteMany({ where: { id: relation.id } });
      await cleanupByEmail(adminEmail);
      await cleanupByEmail(mentorEmail);
      await cleanupByEmail(menteeEmail);
    }
  }
);

test('the Announcements box shows a live counter and caps input at the API limit', async ({ page }) => {
  const adminEmail = uniqueEmail('limits-announce');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Announce Limits Admin');

  try {
    await signIn(page, adminEmail, 'AdminPass123');
    await page.goto('/admin/announcements');

    const box = page.getByTestId('announcement-text');
    const counter = page.getByTestId('textarea-counter');

    // Present and counting from the first keystroke — this is what was missing.
    await expect(counter).toBeVisible();
    await box.fill('merhaba');
    await expect(counter).toHaveText('7/20000');
    await expect(counter).toHaveAttribute('data-counter-state', 'normal');

    // The native maxLength truncates rather than letting the admin write past
    // the server's cap and get a bare "Validation failed" on submit.
    await box.fill('x'.repeat(20_050));
    expect(await box.inputValue()).toHaveLength(20_000);
    await expect(counter).toHaveText('20000/20000');
    await expect(counter).toHaveAttribute('data-counter-state', 'error');

    // Warning band at >=80% (16 000 of 20 000).
    await box.fill('y'.repeat(17_000));
    await expect(counter).toHaveAttribute('data-counter-state', 'warning');
  } finally {
    await cleanupByEmail(adminEmail);
  }
});

test('a long announcement submits successfully instead of failing validation', async ({ page }) => {
  const adminEmail = uniqueEmail('limits-longpost');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Long Post Admin');
  // Deliberately long-form, the case that produced the reported
  // "Validation failed" banner when the cap was invisible.
  const marker = `E2E long announcement ${Date.now().toString(36)}`;
  const longText = `${marker} ${'asdfas dfasdf asdf asdfas dfasdf '.repeat(120)}`;

  try {
    await signIn(page, adminEmail, 'AdminPass123');
    await page.goto('/admin/announcements');
    await page.getByTestId('announcement-text').fill(longText);

    const postDone = page.waitForResponse(
      (r) => r.url().includes('/api/admin/announcements') && r.request().method() === 'POST'
    );
    await page.getByRole('button', { name: /^Broadcast$/i }).click();
    const response = await postDone;
    expect(response.status(), await response.text()).toBe(201);

    // No error banner, and the record is real.
    await expect(page.getByText('Validation failed')).toHaveCount(0);
    const record = await prisma.announcement.findFirst({ where: { text: longText } });
    expect(record).not.toBeNull();
  } finally {
    await prisma.announcement.deleteMany({ where: { text: longText } });
    await cleanupByEmail(adminEmail);
  }
});

test('a company description longer than the old 191-char column round-trips', async ({ page }) => {
  const adminEmail = uniqueEmail('limits-company');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Company Limits Admin');
  const name = `E2E Limits Co ${Date.now().toString(36)}`;
  const description = 'Şirket açıklaması — '.repeat(60).slice(0, 900);

  try {
    await signIn(page, adminEmail, 'AdminPass123');

    const res = await page.request.post('/api/companies', { data: { name, description } });
    expect(res.status(), await res.text()).toBeLessThan(300);

    const stored = await prisma.company.findFirst({ where: { name } });
    expect(stored?.description).toBe(description);
  } finally {
    await prisma.company.deleteMany({ where: { name } });
    await cleanupByEmail(adminEmail);
  }
});

test('the server rejects over-limit text with 400, not 500, when the client is bypassed', async ({ page }) => {
  const adminEmail = uniqueEmail('limits-bypass');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Bypass Limits Admin');

  try {
    await signIn(page, adminEmail, 'AdminPass123');

    // Past the zod cap: must be a clean validation failure. A 500 here means a
    // client-only limit is the last line of defence again.
    const res = await page.request.post('/api/admin/announcements', {
      data: { text: 'z'.repeat(20_001) },
    });
    expect(res.status()).toBe(400);

    // A link past the column width must also validate rather than blow up.
    const linkRes = await page.request.post('/api/admin/announcements', {
      data: { text: 'ok', link: `https://example.com/${'a'.repeat(600)}` },
    });
    expect(linkRes.status()).toBe(400);
  } finally {
    await cleanupByEmail(adminEmail);
  }
});
