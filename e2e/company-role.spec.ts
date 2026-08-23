import { test, expect } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('a COMPANY user sees their linked candidates read-only and cannot reach admin', async ({ page }) => {
  const companyEmail = uniqueEmail('companyuser');
  const mentorEmail = uniqueEmail('coMentor');
  const menteeEmail = uniqueEmail('coMentee');
  const pw = 'CompanyPass123!';

  // COMPANY reads of /api/mentorship fail closed without a tenant (#1227), so
  // the company user and the relation must share an org, same as production.
  const org = await prisma.organization.create({
    data: { name: `Acme Org ${Date.now()}`, slug: `acme-role-${Date.now()}` },
  });
  const company = await prisma.company.create({ data: { name: `Acme ${Date.now()}`, orgId: org.id } });
  const companyUser = await prisma.user.create({
    data: {
      email: companyEmail,
      password: await bcrypt.hash(pw, 10),
      role: 'COMPANY',
      fullName: 'Acme Observer',
      companyId: company.id,
      orgId: org.id,
      skills: [],
    },
  });
  const mentor = await seedUser(mentorEmail, 'x', 'MENTOR', 'Co Mentor');
  const mentee = await seedUser(menteeEmail, 'x', 'MENTEE', 'Linked Candidate');
  const rel = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, companyId: company.id, orgId: org.id },
  });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', companyEmail);
    await page.fill('input[type="password"]', pw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/company'), { timeout: 20_000 });

    // Sees the candidate linked to its company.
    await expect(page.getByText('Linked Candidate')).toBeVisible({ timeout: 10_000 });

    // Cannot access the admin panel (redirected away).
    await page.goto('/admin');
    await page.waitForURL((u) => !u.pathname.startsWith('/admin'), { timeout: 20_000 });
    expect(new URL(page.url()).pathname.startsWith('/admin')).toBe(false);
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
    await prisma.user.deleteMany({ where: { id: companyUser.id } });
    await prisma.company.deleteMany({ where: { id: company.id } });
    await prisma.organization.deleteMany({ where: { id: org.id } });
  }
});
