import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail, acceptContributorTerms } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #1114: a mentee could not reach their own project. The authorization layer
// already allowed it (scopeForRole + the detail page's member branch), but the
// portal never linked there: no sidebar entry, no dashboard card, and the only
// list page — /projects — is the `isPublic: true` showcase, so a private project
// they were assigned to appeared nowhere.
//
// Both membership sources must work (mergeTeam unions them): a ProjectMember row
// and a legacy MentorshipRelation.projectId.
test('mentee portal: own private projects are listed, foreign ones are not', { tag: '@smoke' }, async ({ page }) => {
  const adminEmail = uniqueEmail('pp-admin');
  const menteeEmail = uniqueEmail('pp-mentee');
  const otherEmail = uniqueEmail('pp-other');
  const pw = 'PortalProj123';
  const admin = await seedUser(adminEmail, 'x', 'ADMIN', 'PP Admin');
  const mentee = await seedUser(menteeEmail, pw, 'MENTEE', 'PP Mentee');
  const other = await seedUser(otherEmail, 'x', 'MENTEE', 'PP Other');

  // Assigned the legacy way: MentorshipRelation.projectId.
  const viaRelation = await prisma.project.create({
    data: { name: 'PP Relation Project', ownerType: 'ADMIN', ownerUserId: admin.id, isPublic: false, technologies: ['Rust'] },
  });
  // Assigned the current way: a ProjectMember row, with no relation behind it.
  const viaMember = await prisma.project.create({
    data: {
      name: 'PP Member Project', ownerType: 'ADMIN', ownerUserId: admin.id, isPublic: false,
      members: { create: [{ userId: mentee.id, role: 'MENTEE', functionalRole: 'DEVELOPER' }] },
    },
  });
  // A private project this mentee has nothing to do with — must stay invisible.
  const foreign = await prisma.project.create({
    data: {
      name: 'PP Foreign Project', ownerType: 'ADMIN', ownerUserId: admin.id, isPublic: false,
      members: { create: [{ userId: other.id, role: 'MENTEE' }] },
    },
  });
  const relation = await prisma.mentorshipRelation.create({
    data: { mentorId: admin.id, menteeId: mentee.id, status: 'ACTIVE', projectId: viaRelation.id },
  });
  // /portal/projects is behind the contributor-terms gate (#1025); a mentee who
  // is actually working on projects has accepted them.
  await acceptContributorTerms(mentee.id);

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', menteeEmail);
    await page.fill('input[type="password"]', pw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    // The dashboard now says the mentee has projects at all.
    const card = page.getByTestId('portal-projects-card');
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card.getByText('PP Relation Project')).toBeVisible();

    // The sidebar link is the durable way in (the whole point of the fix).
    await page.getByRole('link', { name: 'Projects' }).first().click();
    await page.waitForURL((u) => u.pathname === '/portal/projects', { timeout: 20_000 });

    const list = page.getByTestId('portal-projects-list');
    await expect(list.getByText('PP Relation Project')).toBeVisible({ timeout: 10_000 });
    await expect(list.getByText('PP Member Project')).toBeVisible();
    await expect(page.getByText('PP Foreign Project')).toHaveCount(0);

    // …and the detail page opens with the member's internal view, not the
    // visitor's stub.
    await page.getByTestId(`portal-project-card-${viaMember.id}`).getByTestId('portal-project-detail-link').click();
    await page.waitForURL((u) => u.pathname === `/projects/${viaMember.id}`, { timeout: 20_000 });
    await expect(page.getByRole('heading', { name: 'PP Member Project' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('project-internal')).toBeVisible();

    // The back link returns to the mentee's own list — it used to send them to
    // the public showcase, which does not contain this project.
    await page.getByRole('link', { name: 'All projects' }).click();
    await page.waitForURL((u) => u.pathname === '/portal/projects', { timeout: 20_000 });
  } finally {
    await prisma.mentorshipRelation.delete({ where: { id: relation.id } }).catch(() => {});
    await prisma.project.deleteMany({ where: { id: { in: [viaRelation.id, viaMember.id, foreign.id] } } });
    await cleanupByEmail(otherEmail);
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(adminEmail);
  }
});
