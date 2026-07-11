import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #616: /projects/[id] serves two audiences — the public PII-free showcase
// view (public projects only), and an internal view for admins/owners with
// members, goals, dates and task progress, including private projects.
test('project detail: internal section for the admin, PII-free public view, 404 for private+anonymous', async ({ browser }) => {
  const adminEmail = uniqueEmail('pd-admin');
  const menteeEmail = uniqueEmail('pd-mentee');
  const pw = 'DetailPass123';
  const admin = await seedUser(adminEmail, pw, 'ADMIN', 'Detail Admin');
  const mentee = await seedUser(menteeEmail, 'x', 'MENTEE', 'Detail Member');

  const priv = await prisma.project.create({
    data: {
      name: 'Private Detail Project', ownerType: 'ADMIN', ownerUserId: admin.id, isPublic: false,
      technologies: ['Rust'], goals: 'Ship the detail view',
      tasks: { create: [{ title: 'Done task', done: true, order: 1 }, { title: 'Open task', done: false, order: 2 }] },
    },
  });
  const pub = await prisma.project.create({
    data: { name: 'Public Detail Project', ownerType: 'ADMIN', ownerUserId: admin.id, isPublic: true, technologies: ['Go'] },
  });
  const relation = await prisma.mentorshipRelation.create({
    data: { mentorId: admin.id, menteeId: mentee.id, status: 'ACTIVE', projectId: priv.id },
  });

  const adminCtx = await browser.newContext();
  const anonCtx = await browser.newContext();
  try {
    // Admin sees the private project with the internal section.
    const adminPage = await adminCtx.newPage();
    await adminPage.goto('/auth/signin');
    await adminPage.fill('input[type="email"], input[name="email"]', adminEmail);
    await adminPage.fill('input[type="password"]', pw);
    await adminPage.click('button[type="submit"]');
    await adminPage.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    await adminPage.goto(`/projects/${priv.id}`);
    await expect(adminPage.getByRole('heading', { name: 'Private Detail Project' })).toBeVisible({ timeout: 10_000 });
    const internal = adminPage.getByTestId('project-internal');
    await expect(internal).toBeVisible();
    await expect(internal.getByText('Detail Member')).toBeVisible();
    await expect(internal.getByText('Ship the detail view')).toBeVisible();
    await expect(internal.getByText('Open task')).toBeVisible();

    // Anonymous: private project 404s; public project renders without the
    // internal section (no member names — PII-free).
    const anonPage = await anonCtx.newPage();
    const res = await anonPage.goto(`/projects/${priv.id}`);
    expect(res!.status()).toBe(404);
    await anonPage.goto(`/projects/${pub.id}`);
    await expect(anonPage.getByRole('heading', { name: 'Public Detail Project' })).toBeVisible({ timeout: 10_000 });
    await expect(anonPage.getByTestId('project-internal')).toHaveCount(0);
    await expect(anonPage.getByText('Detail Member')).toHaveCount(0);
  } finally {
    await adminCtx.close();
    await anonCtx.close();
    await prisma.mentorshipRelation.delete({ where: { id: relation.id } }).catch(() => {});
    await prisma.project.deleteMany({ where: { id: { in: [priv.id, pub.id] } } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(adminEmail);
  }
});
