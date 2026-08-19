import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #618 UI: the "Manage owners & mentors" panel — add a mentor as OWNER from the
// picker, then remove; the last-owner guard error surfaces inline.
//
// The panel moved from the project *card* to the project page (#51): a project
// had two half-views, and the card's copy is the one that went away. The card's
// members icon is now a link to the same panel.
test('owners panel: add an owner from the picker; last-owner removal shows the error', async ({ browser }) => {
  const adminEmail = uniqueEmail('own-admin');
  const mentorEmail = uniqueEmail('own-mentor');
  const pw = 'OwnersPass123';
  const admin = await seedUser(adminEmail, pw, 'ADMIN', 'Owners Admin');
  const mentor = await seedUser(mentorEmail, 'x', 'MENTOR', 'Owners Mentor');

  const project = await prisma.project.create({
    data: {
      name: 'Owners UI Project', ownerType: 'ADMIN', ownerUserId: admin.id, technologies: [],
      members: { create: { userId: admin.id, role: 'OWNER' } },
    },
  });

  const ctx = await browser.newContext();
  try {
    const page = await ctx.newPage();
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', pw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    await page.goto('/admin/projects');
    const card = page.locator('[data-testid="project-card"]', { hasText: 'Owners UI Project' });
    await expect(card).toBeVisible({ timeout: 10_000 });
    // The card's members icon opens the project page, where the panel lives.
    await card.getByTestId('manage-owners').click();
    await page.waitForURL(new RegExp(`/projects/${project.id}`), { timeout: 20_000 });
    const panel = page.getByTestId('members-panel');
    // Scope to the member list: the panel also contains the member-picker
    // <select>, whose options are the users NOT in the project — so a removed
    // member reappears there and a panel-wide text match still finds them.
    const members = panel.getByTestId('owners-members');
    await expect(panel).toBeVisible();
    await expect(members.getByText('Owners Admin')).toBeVisible();

    // Add the mentor as a second OWNER from the picker.
    await panel.getByTestId('member-picker').selectOption(mentor.id);
    await panel.locator('select').nth(1).selectOption('OWNER');
    await panel.getByTestId('member-add').click();
    await expect(members.getByText('Owners Mentor')).toBeVisible({ timeout: 10_000 });
    expect(await prisma.projectMember.count({ where: { projectId: project.id, role: 'OWNER' } })).toBe(2);

    // Remove the mentor again, then try to remove the last owner → inline error.
    // Target the row's own remove button by id: `locator('div', { hasText })`
    // matches every ancestor div containing the name, and .last() is not
    // reliably the member row, so the click could land on another button.
    await panel.getByTestId(`member-remove-${mentor.id}`).click();
    await expect(members.getByText('Owners Mentor')).toHaveCount(0, { timeout: 10_000 });
    await panel.getByTestId(`member-remove-${admin.id}`).click();
    await expect(panel.getByText('at least one owner', { exact: false })).toBeVisible({ timeout: 10_000 });
  } finally {
    await ctx.close();
    await prisma.project.deleteMany({ where: { id: project.id } });
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  }
});

// #1222: mentees are a valid project owner type. API-level regression: an
// admin can create a MENTEE-owned project, and resolveOwner still refuses an
// owner whose actual role does not match the claimed ownerType.
test('a mentee can own a project; role mismatch is rejected', async ({ page }) => {
  const adminEmail = uniqueEmail('menteeowner-admin');
  const menteeEmail = uniqueEmail('menteeowner-mentee');
  const mentorEmail = uniqueEmail('menteeowner-mentor');
  const pw = 'Pass123!';
  await seedUser(adminEmail, pw, 'ADMIN', 'MenteeOwner Admin');
  const mentee = await seedUser(menteeEmail, 'x', 'MENTEE', 'MenteeOwner Mentee');
  const mentor = await seedUser(mentorEmail, 'x', 'MENTOR', 'MenteeOwner Mentor');

  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', adminEmail);
  await page.fill('input[type="password"]', pw);
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => !url.pathname.startsWith('/auth'), { timeout: 20_000 });

  let projectId = '';
  try {
    const ok = await page.request.post('/api/projects', {
      data: { name: 'Mentee-Owned Project', ownerType: 'MENTEE', ownerUserId: mentee.id },
    });
    expect(ok.status()).toBe(201);
    projectId = (await ok.json()).project?.id ?? (await ok.json()).id ?? '';
    const row = await prisma.project.findFirst({ where: { name: 'Mentee-Owned Project' } });
    expect(row?.ownerType).toBe('MENTEE');
    expect(row?.ownerUserId).toBe(mentee.id);
    projectId = row?.id ?? projectId;

    // Claiming MENTEE ownership for a MENTOR-role user must be refused.
    const bad = await page.request.post('/api/projects', {
      data: { name: 'Bad Owner Project', ownerType: 'MENTEE', ownerUserId: mentor.id },
    });
    expect(bad.status()).toBe(400);
  } finally {
    if (projectId) await prisma.project.delete({ where: { id: projectId } }).catch(() => {});
    await cleanupByEmail(adminEmail);
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});
