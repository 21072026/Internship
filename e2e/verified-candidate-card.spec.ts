import { test, expect } from '@playwright/test';
import { prisma, cleanupByEmail, uniqueEmail } from './helpers/db';
import bcrypt from 'bcryptjs';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// Premium Faz 1 (#529): the "verified candidate card" — mentor evaluations +
// project contributions — is surfaced only when the company holds the
// VERIFIED_CANDIDATE_CARD entitlement. Locked by default (free core preserved),
// unlocked after granting. Driven via the authenticated API to avoid the admin
// sidebar search-box locator clashes noted in CLAUDE.md.
test('verified section is hidden without the entitlement and appears after granting it', async ({ page }) => {
  const companyEmail = uniqueEmail('verified-company');
  const mentorEmail = uniqueEmail('verified-mentor');
  const menteeEmail = uniqueEmail('verified-mentee');
  const pw = 'VerifiedPass123';

  const company = await prisma.company.create({ data: { name: `Verified Co ${Date.now()}` } });
  const hash = await bcrypt.hash(pw, 10);
  const companyUser = await prisma.user.create({
    data: { email: companyEmail, password: hash, role: 'COMPANY', fullName: 'Verified Company User', skills: [], companyId: company.id },
  });
  const mentor = await prisma.user.create({
    data: { email: mentorEmail, password: hash, role: 'MENTOR', fullName: 'Verified Mentor', skills: [] },
  });
  const mentee = await prisma.user.create({
    data: { email: menteeEmail, password: hash, role: 'MENTEE', fullName: 'Verified Mentee', skills: [] },
  });

  const project = await prisma.project.create({
    data: {
      name: 'Verified Demo Project',
      description: 'A project built during the internship.',
      technologies: ['TypeScript', 'Next.js'],
      ownerType: 'MENTOR',
      ownerUserId: mentor.id,
      tasks: { create: [{ title: 'Task A', done: true }, { title: 'Task B', done: false }] },
    },
  });
  const relation = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, companyId: company.id, projectId: project.id },
  });
  await prisma.evaluation.create({
    data: { relationId: relation.id, authorId: mentor.id, type: 'FINAL', scores: { communication: 5, technical: 4 }, comment: 'Excellent progress.' },
  });

  const url = `/api/company/candidates/${mentee.id}`;

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', companyEmail);
    await page.fill('input[type="password"]', pw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.startsWith('/auth'), { timeout: 20_000 });

    // Locked: without the entitlement, the API omits the verified block.
    const locked = await page.request.get(url);
    expect(locked.ok()).toBeTruthy();
    expect((await locked.json()).verified).toBeNull();

    // Grant the premium feature.
    await prisma.companyEntitlement.create({ data: { companyId: company.id, feature: 'VERIFIED_CANDIDATE_CARD' } });

    // Unlocked: evaluations + project contributions are now present.
    const unlocked = await page.request.get(url);
    expect(unlocked.ok()).toBeTruthy();
    const body = await unlocked.json();
    expect(body.verified).not.toBeNull();
    expect(body.verified.evaluations).toHaveLength(1);
    expect(body.verified.evaluations[0].comment).toBe('Excellent progress.');
    expect(body.verified.evaluations[0].authorName).toBe('Verified Mentor');
    expect(body.verified.projects).toHaveLength(1);
    expect(body.verified.projects[0].name).toBe('Verified Demo Project');
    expect(body.verified.projects[0].tasksTotal).toBe(2);
    expect(body.verified.projects[0].tasksDone).toBe(1);
  } finally {
    await prisma.evaluation.deleteMany({ where: { relationId: relation.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: relation.id } });
    await prisma.projectTask.deleteMany({ where: { projectId: project.id } });
    await prisma.project.delete({ where: { id: project.id } }).catch(() => {});
    await prisma.companyEntitlement.deleteMany({ where: { companyId: company.id } });
    await prisma.user.delete({ where: { id: companyUser.id } }).catch(() => {});
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeEmail);
    await prisma.company.delete({ where: { id: company.id } }).catch(() => {});
  }
});
