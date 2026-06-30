import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// Regression for #331: an existing mentorship's company could only be set at
// creation time; the list page now exposes a picker to reassign (or clear) it.
test('admin can change the company on an existing mentorship', async ({ page }) => {
  const mentorEmail = uniqueEmail('mentor');
  const menteeEmail = uniqueEmail('mentee');
  const suffix = Date.now().toString(36);
  const menteeName = `CompChange Mentee ${suffix}`;
  const mentor = await seedUser(mentorEmail, 'Pass1234!', 'MENTOR', `CompChange Mentor ${suffix}`);
  const mentee = await seedUser(menteeEmail, 'Pass1234!', 'MENTEE', menteeName);
  const company = await prisma.company.create({ data: { name: `CompChange Co ${suffix}` } });
  // Start with no company assigned.
  const relation = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id },
  });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', ADMIN_EMAIL);
    await page.fill('input[type="password"]', ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.includes('/auth/signin'), { timeout: 20_000 });

    await page.goto('/admin/mentorship');
    // The list can hold many relations; narrow it to our seeded one by name so
    // the company picker resolves to a single element. Target the mentorship
    // search box specifically (the admin layout also has a "Filter menu" search
    // input); the regex matches the en/tr/de placeholders.
    await page.getByPlaceholder(/mentor, mentee/i).fill(menteeName);

    const companySelect = page.getByLabel('Change company');
    await expect(companySelect).toHaveCount(1);

    // Initially unassigned.
    await expect(companySelect).toHaveValue('');

    const putDone = page.waitForResponse(
      (r) => r.url().includes(`/api/mentorship/${relation.id}`) && r.request().method() === 'PUT'
    );
    await companySelect.selectOption(company.id);
    await putDone;
    await page.waitForTimeout(400);

    const updated = await prisma.mentorshipRelation.findUnique({ where: { id: relation.id } });
    expect(updated?.companyId).toBe(company.id);
  } finally {
    await prisma.mentorshipRelation.delete({ where: { id: relation.id } }).catch(() => {});
    await prisma.company.delete({ where: { id: company.id } }).catch(() => {});
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeEmail);
  }
});
