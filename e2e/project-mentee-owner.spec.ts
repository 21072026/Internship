import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail, acceptContributorTerms } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #2270: a mentee can start a project and manage the one they created.
//
// Ownership was already expressible (#1222 gave `ProjectOwnerType` its MENTEE
// member) but only an admin could assign it, there was no form anywhere a
// mentee could reach, and three sibling guards compared `session.user.role` to
// a role string — so a mentee OWNER was locked out of their own project's
// member list and to-dos. The ownership-based helpers (`isProjectOwner`,
// `canManageProject`) were role-blind all along, which is why
// `/api/projects/[id]` needs no change.

async function signIn(page: import('@playwright/test').Page, email: string, password: string) {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
}

test('a mentee creates a project from the portal and edits the one they own', { tag: '@smoke' }, async ({ page }) => {
  const email = uniqueEmail('mo-mentee');
  const pw = 'MenteeOwn123';
  const mentee = await seedUser(email, pw, 'MENTEE', 'MO Mentee');
  // Without the platform-level acceptance /portal/projects renders the
  // contributor-terms gate instead of the page (the trap #1025 left behind).
  await acceptContributorTerms(mentee.id);

  try {
    await signIn(page, email, pw);
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    await page.goto('/portal/projects');
    // The empty state offers "start one" as well as "join one".
    await expect(page.getByTestId('portal-projects-empty')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('portal-add-project').first().click();
    await page.getByLabel(/^Name/).fill('MO Solar Tracker');
    await page.getByLabel(/Technologies/).fill('Rust, Postgres');
    const created = page.waitForResponse((r) => r.url().endsWith('/api/projects') && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Create' }).click();
    expect((await created).status()).toBe(201);

    // Owned by the creator, with the OWNER member row — never an orphan.
    const project = await prisma.project.findFirst({
      where: { ownerUserId: mentee.id },
      include: { members: true },
    });
    expect(project?.ownerType).toBe('MENTEE');
    expect(project?.members.filter((m) => m.role === 'OWNER').map((m) => m.userId)).toEqual([mentee.id]);
    // A mentee's own project starts private (the showcase is anonymous).
    expect(project?.isPublic).toBe(false);

    // …and it is listed for its owner even though it is private.
    const list = page.getByTestId('portal-projects-list');
    await expect(list.getByText('MO Solar Tracker', { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId(`portal-project-owned-${project!.id}`)).toBeVisible();

    // Editing an owner-only field (name) through the same shared form.
    await page.getByTestId(`portal-project-edit-${project!.id}`).click();
    await page.getByLabel(/^Name/).fill('MO Solar Tracker v2');
    const saved = page.waitForResponse(
      (r) => r.url().includes(`/api/projects/${project!.id}`) && r.request().method() === 'PUT'
    );
    await page.getByRole('button', { name: 'Save' }).click();
    expect((await saved).status()).toBe(200);
    await expect(list.getByText('MO Solar Tracker v2', { exact: true })).toBeVisible({ timeout: 10_000 });

    // The scope must not depend on the OWNER member row surviving: a project
    // whose row is gone (seeder, backfill, member removal) is still the owner's.
    await prisma.projectMember.deleteMany({ where: { projectId: project!.id, userId: mentee.id } });
    const listed = await page.request.get('/api/projects');
    const ids = ((await listed.json()).projects as { id: string }[]).map((p) => p.id);
    expect(ids).toContain(project!.id);
    // …and the roster too: the members guard read OWNER rows only, so the demo
    // set (ownerUserId, no member row, no backfill on topic/preview deploys)
    // rendered the panel for an owner whose every fetch answered 403.
    const rosterWithoutMemberRow = await page.request.get(`/api/projects/${project!.id}/members`);
    expect(rosterWithoutMemberRow.status()).toBe(200);

    // The programme's two flags are not the creator's to set: a mentee POST
    // asking to publish the project and to switch the project-level IP gate off
    // is ignored, and a later PUT asking for the same is refused outright.
    const sneaky = await page.request.post('/api/projects', {
      data: { name: 'MO Ungated', isPublic: true, contributorTermsRequired: false, contributorTermsKey: 'zzz' },
    });
    expect(sneaky.status()).toBe(201);
    const ungated = await prisma.project.findFirst({ where: { name: 'MO Ungated' } });
    expect(ungated).toMatchObject({ isPublic: false, contributorTermsRequired: true, contributorTermsKey: null });
    const publish = await page.request.put(`/api/projects/${ungated!.id}`, { data: { isPublic: true } });
    expect(publish.status()).toBe(403);
    expect((await publish.json()).code).toBe('programme_only');
  } finally {
    await prisma.project.deleteMany({ where: { ownerUserId: mentee.id } });
    await cleanupByEmail(email);
  }
});

test('a mentee owner manages their project; a plain member and other roles do not', async ({ page }) => {
  const ownerEmail = uniqueEmail('mo-owner');
  const memberEmail = uniqueEmail('mo-member');
  const sourceEmail = uniqueEmail('mo-source');
  const pw = 'MenteeOwn123';
  const owner = await seedUser(ownerEmail, pw, 'MENTEE', 'MO Owner');
  const member = await seedUser(memberEmail, pw, 'MENTEE', 'MO Member');
  await seedUser(sourceEmail, pw, 'SOURCE', 'MO Source');
  await acceptContributorTerms(owner.id);

  const project = await prisma.project.create({
    data: {
      name: 'MO Managed', ownerType: 'MENTEE', ownerUserId: owner.id, isPublic: false,
      members: { create: [{ userId: owner.id, role: 'OWNER' }, { userId: member.id, role: 'MENTEE' }] },
    },
  });
  // A to-do assigned to the other member: the owner may delete it, the member
  // may not (#1113's rule is about a plain member, not about the role string).
  const foreignTask = await prisma.projectTask.create({
    data: { projectId: project.id, title: 'MO Foreign Task', assigneeId: member.id, createdById: owner.id },
  });

  try {
    await signIn(page, ownerEmail, pw);
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    // The owner reads their own roster — this used to 401 for every MENTEE.
    const members = await page.request.get(`/api/projects/${project.id}/members`);
    expect(members.status()).toBe(200);
    expect(((await members.json()).members as unknown[]).length).toBe(2);

    // Owner-only fields on their own project.
    const put = await page.request.put(`/api/projects/${project.id}`, { data: { name: 'MO Managed v2', status: 'DRAFT' } });
    expect(put.status()).toBe(200);

    // Project to-dos are the owner's to write and to retire.
    const task = await page.request.post(`/api/projects/${project.id}/tasks`, { data: { title: 'MO Owner Task' } });
    expect(task.status()).toBe(201);
    const del = await page.request.delete(`/api/project-tasks/${foreignTask.id}`);
    expect(del.status()).toBe(200);

    // Join requests are how a mentee owner grows the team; adding directly is
    // refused on purpose (no relation check, and it notifies the target).
    expect((await page.request.get(`/api/projects/${project.id}/join-requests`)).status()).toBe(200);
    const directAdd = await page.request.post(`/api/projects/${project.id}/members`, {
      data: { userId: member.id, role: 'MENTEE' },
    });
    expect(directAdd.status()).toBe(403);
    expect((await directAdd.json()).code).toBe('mentee_owner_invite');

    // A plain mentee member gets neither the roster nor someone else's to-do.
    const memberCtx = await page.context().browser()!.newContext();
    const memberPage = await memberCtx.newPage();
    try {
      await signIn(memberPage, memberEmail, pw);
      await memberPage.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });
      expect((await memberPage.request.get(`/api/projects/${project.id}/members`)).status()).toBe(403);
      const own = await prisma.projectTask.create({
        data: { projectId: project.id, title: 'MO Other Task', createdById: owner.id },
      });
      expect((await memberPage.request.delete(`/api/project-tasks/${own.id}`)).status()).toBe(403);
      const memberPut = await memberPage.request.put(`/api/projects/${project.id}`, { data: { name: 'Nope' } });
      expect(memberPut.status()).toBe(403);
    } finally {
      await memberCtx.close();
    }

    // A SOURCE has no project workflow: creation is forbidden, not unauthorized.
    const srcCtx = await page.context().browser()!.newContext();
    const srcPage = await srcCtx.newPage();
    try {
      await signIn(srcPage, sourceEmail, pw);
      await srcPage.waitForURL((u) => !u.pathname.startsWith('/auth'), { timeout: 20_000 });
      const post = await srcPage.request.post('/api/projects', { data: { name: 'MO Source Project' } });
      expect(post.status()).toBe(403);
    } finally {
      await srcCtx.close();
    }
  } finally {
    await prisma.projectTask.deleteMany({ where: { projectId: project.id } });
    await prisma.project.deleteMany({ where: { id: project.id } });
    await cleanupByEmail(sourceEmail);
    await cleanupByEmail(memberEmail);
    await cleanupByEmail(ownerEmail);
  }
});

// The legacy single-owner pointer must never claim a mentee is a MENTOR owner:
// `resolveOwner()` would reject the row it produced (#2270).
test('removing a mentee owner repoints ownerType at the mentee successor', async ({ page }) => {
  const adminEmail = uniqueEmail('mo-admin');
  const aEmail = uniqueEmail('mo-a');
  const bEmail = uniqueEmail('mo-b');
  const pw = 'MenteeOwn123';
  await seedUser(adminEmail, pw, 'ADMIN', 'MO Admin');
  const a = await seedUser(aEmail, pw, 'MENTEE', 'MO A');
  const b = await seedUser(bEmail, pw, 'MENTEE', 'MO B');

  const project = await prisma.project.create({
    data: {
      name: 'MO Succession', ownerType: 'MENTEE', ownerUserId: a.id, isPublic: false,
      members: { create: [{ userId: a.id, role: 'OWNER' }, { userId: b.id, role: 'OWNER' }] },
    },
  });

  try {
    await signIn(page, adminEmail, pw);
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    const removed = await page.request.delete(`/api/projects/${project.id}/members`, { data: { userId: a.id } });
    expect(removed.ok()).toBeTruthy();
    const after = await prisma.project.findUnique({
      where: { id: project.id },
      select: { ownerUserId: true, ownerType: true },
    });
    expect(after).toMatchObject({ ownerUserId: b.id, ownerType: 'MENTEE' });
  } finally {
    await prisma.project.deleteMany({ where: { id: project.id } });
    await cleanupByEmail(bEmail);
    await cleanupByEmail(aEmail);
    await cleanupByEmail(adminEmail);
  }
});
