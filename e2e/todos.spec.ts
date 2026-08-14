import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, signInAsFreshUser, gotoSettled } from './helpers/auth';
import { acceptConfirmDialog } from './helpers/confirm';

/**
 * The to-do list, reworked (#1113).
 *
 * What this locks down, all of it a regression somebody hit:
 *  - a to-do from the shared pool is a *reference*: reword the pool entry and the
 *    wording changes for whoever has it, in their own language; retire it and
 *    they keep it
 *  - the person it was given to may tick it off and archive it, but not reword or
 *    delete it
 *  - handing to-dos out no longer feeds them back into the pool they came from,
 *    which is what made the same wording pile up round after round
 *  - a person can write their own to-dos, and mentor-given and project to-dos sit
 *    on the same page as those
 */

const password = 'TodoPass123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('a shared to-do follows the pool: reworded everywhere, retired without loss', async ({ page }) => {
  test.slow();
  const adminEmail = uniqueEmail('todo-admin');
  const menteeEmail = uniqueEmail('todo-mentee');
  const admin = await seedUser(adminEmail, password, 'ADMIN', 'Todo Admin');
  const mentee = await seedUser(menteeEmail, password, 'MENTEE', 'Todo Mentee');
  // The mentee reads the app in Turkish: that is the wording they must get.
  await prisma.user.update({ where: { id: mentee.id }, data: { preferredLanguage: 'tr' } });

  const stamp = Date.now();
  const en = `Read the onboarding guide ${stamp}`;
  const tr = `Başlangıç rehberini oku ${stamp}`;
  const enFixed = `Read the onboarding guide carefully ${stamp}`;
  const trFixed = `Başlangıç rehberini dikkatle oku ${stamp}`;
  const template = await prisma.projectTaskTemplate.create({
    data: { projectId: null, title: en, translations: { en, tr } },
  });

  try {
    // An admin hands the shared to-do straight to the mentee — no project needed.
    await signInAndSettle(page, adminEmail, password, '/admin');
    const sent = await page.request.post('/api/todos', {
      data: { templateIds: [template.id], assigneeId: mentee.id },
    });
    expect(sent.status()).toBe(201);
    const task = await prisma.projectTask.findFirstOrThrow({ where: { assigneeId: mentee.id } });
    expect(task.templateId).toBe(template.id);

    // The mentee reads it in Turkish on their own list.
    await signInAsFreshUser(page, menteeEmail, password, '/portal');
    await gotoSettled(page, '/todos');
    const row = page.getByTestId(`todo-${task.id}`);
    await expect(row).toContainText(tr);
    // It is marked as shared, and offers no edit or delete — only a tick and the
    // archive.
    await expect(page.getByTestId(`todo-shared-${task.id}`)).toBeVisible();
    await expect(page.getByTestId(`todo-edit-${task.id}`)).toHaveCount(0);
    await expect(page.getByTestId(`todo-delete-${task.id}`)).toHaveCount(0);

    // And the API says the same, not just the UI.
    const reword = await page.request.patch(`/api/project-tasks/${task.id}`, { data: { title: 'mine now' } });
    expect(reword.status()).toBe(409);
    const drop = await page.request.delete(`/api/project-tasks/${task.id}`);
    expect(drop.status()).toBe(403);

    // Ticking it off and putting it away is theirs to do.
    await page.getByTestId(`todo-check-${task.id}`).click();
    await expect
      .poll(async () => (await prisma.projectTask.findUnique({ where: { id: task.id } }))?.done, { timeout: 10_000 })
      .toBe(true);
    await page.getByTestId(`todo-archive-${task.id}`).click();
    await expect
      .poll(
        async () => (await prisma.projectTask.findUnique({ where: { id: task.id } }))?.archivedAt !== null,
        { timeout: 10_000 }
      )
      .toBe(true);
    // Archived means "off the list", not "gone": it reads back from the archive.
    await page.getByTestId('todo-archive-toggle').click();
    await expect(page.getByTestId(`todo-${task.id}`)).toContainText(tr);

    // The admin rewords the pool entry in both languages …
    await signInAsFreshUser(page, adminEmail, password, '/admin');
    const patched = await page.request.patch('/api/admin/goal-templates', {
      data: { id: template.id, translations: { en: enFixed, tr: trFixed } },
    });
    expect(patched.ok()).toBeTruthy();

    // … and the mentee's to-do now reads the new Turkish wording. Nothing was
    // copied when it was handed over, so there is nothing to re-send.
    await signInAsFreshUser(page, menteeEmail, password, '/portal');
    await gotoSettled(page, '/todos');
    await page.getByTestId('todo-archive-toggle').click();
    await expect(page.getByTestId(`todo-${task.id}`)).toContainText(trFixed);

    // The admin retires it from the pool: it stops being offered …
    await signInAsFreshUser(page, adminEmail, password, '/admin');
    const removed = await page.request.delete('/api/admin/goal-templates', { data: { id: template.id } });
    expect(removed.ok()).toBeTruthy();
    const pool = await page.request.get('/api/todos/templates');
    expect(((await pool.json()).templates as { id: string }[]).some((x) => x.id === template.id)).toBeFalsy();

    // … and the to-do already handed out is untouched, wording and all.
    await signInAsFreshUser(page, menteeEmail, password, '/portal');
    await gotoSettled(page, '/todos');
    await page.getByTestId('todo-archive-toggle').click();
    await expect(page.getByTestId(`todo-${task.id}`)).toContainText(trFixed);
  } finally {
    await prisma.projectTask.deleteMany({ where: { assigneeId: mentee.id } });
    await prisma.projectTaskTemplate.deleteMany({ where: { id: template.id } });
    await prisma.notification.deleteMany({ where: { userId: { in: [admin.id, mentee.id] } } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(adminEmail);
  }
});

test('a project pool no longer collects the to-dos handed out from it', async ({ page }) => {
  const mentorEmail = uniqueEmail('pool-mentor');
  const menteeEmail = uniqueEmail('pool-mentee');
  const mentor = await seedUser(mentorEmail, password, 'MENTOR', 'Pool Mentor');
  const mentee = await seedUser(menteeEmail, password, 'MENTEE', 'Pool Mentee');

  const stamp = Date.now();
  const shared = await prisma.projectTaskTemplate.create({
    data: { projectId: null, title: `Set up the repo ${stamp}`, translations: { en: `Set up the repo ${stamp}` } },
  });
  const project = await prisma.project.create({
    data: {
      name: `Pool Project ${stamp}`,
      ownerType: 'MENTOR',
      ownerUserId: mentor.id,
      members: {
        create: [
          { userId: mentor.id, role: 'OWNER' },
          { userId: mentee.id, role: 'MENTEE' },
        ],
      },
    },
  });

  try {
    await signInAndSettle(page, mentorEmail, password, '/mentor');

    // Hand out the shared one, and write one by hand.
    const a = await page.request.post(`/api/projects/${project.id}/tasks`, {
      data: { templateIds: [shared.id], assigneeId: mentee.id },
    });
    expect(a.status()).toBe(201);
    const b = await page.request.post(`/api/projects/${project.id}/tasks`, {
      data: { title: `Write the README ${stamp}`, assigneeId: mentee.id },
    });
    expect(b.status()).toBe(201);

    // The pool is still exactly the shared entry: neither to-do was captured
    // back into it, and reading the pool does not backfill from the task list.
    const pool = await page.request.get(`/api/projects/${project.id}/task-templates`);
    const templates = (await pool.json()).templates as { id: string; shared: boolean }[];
    expect(templates.filter((x) => !x.shared)).toHaveLength(0);
    expect(await prisma.projectTaskTemplate.count({ where: { projectId: project.id } })).toBe(0);

    // Adding to the pool is a deliberate act, and then it is there once.
    const added = await page.request.post(`/api/projects/${project.id}/task-templates`, {
      data: { translations: { en: `Review one pull request ${stamp}` } },
    });
    expect(added.status()).toBe(201);
    expect(await prisma.projectTaskTemplate.count({ where: { projectId: project.id } })).toBe(1);
  } finally {
    await prisma.projectTask.deleteMany({ where: { projectId: project.id } });
    await prisma.projectTaskTemplate.deleteMany({ where: { projectId: project.id } });
    await prisma.projectTaskTemplate.deleteMany({ where: { id: shared.id } });
    await prisma.notification.deleteMany({ where: { userId: { in: [mentor.id, mentee.id] } } });
    await prisma.projectMember.deleteMany({ where: { projectId: project.id } });
    await prisma.conversation.deleteMany({ where: { projectId: project.id } });
    await prisma.project.delete({ where: { id: project.id } }).catch(() => {});
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});

test('one page holds what a mentor asked for and what the person wrote themselves', async ({ page }) => {
  test.slow();
  const mentorEmail = uniqueEmail('own-mentor');
  const menteeEmail = uniqueEmail('own-mentee');
  const mentor = await seedUser(mentorEmail, password, 'MENTOR', 'Own Mentor');
  const mentee = await seedUser(menteeEmail, password, 'MENTEE', 'Own Mentee');
  await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });

  const stamp = Date.now();
  const fromMentor = `Prepare for the interview ${stamp}`;
  const own = `Buy a notebook ${stamp}`;

  try {
    // The mentor writes a to-do straight onto the mentee's list, from the mentee
    // page — no project in between.
    await signInAndSettle(page, mentorEmail, password, '/mentor');
    const relation = await prisma.mentorshipRelation.findFirstOrThrow({ where: { menteeId: mentee.id } });
    await gotoSettled(page, `/mentor/mentees/${relation.id}`);
    await page.getByTestId('assign-todo-input').fill(fromMentor);
    await page.getByTestId('assign-todo').click();
    await expect
      .poll(async () => prisma.projectTask.count({ where: { assigneeId: mentee.id } }), { timeout: 10_000 })
      .toBe(1);

    // The mentee finds it on their list, adds one of their own, and both behave
    // like to-dos: theirs is editable and deletable, the mentor's is not theirs
    // to reword.
    await signInAsFreshUser(page, menteeEmail, password, '/portal');
    await gotoSettled(page, '/todos');
    await expect(page.getByTestId('todo-list')).toContainText(fromMentor);

    await page.getByTestId('todo-input').fill(own);
    await page.getByTestId('todo-add').click();
    await expect(page.getByTestId('todo-list')).toContainText(own);

    const mineRow = await prisma.projectTask.findFirstOrThrow({ where: { assigneeId: mentee.id, title: own } });
    await expect(page.getByTestId(`todo-edit-${mineRow.id}`)).toBeVisible();
    await page.getByTestId(`todo-delete-${mineRow.id}`).click();
    await acceptConfirmDialog(page);
    await expect
      .poll(async () => prisma.projectTask.count({ where: { id: mineRow.id } }), { timeout: 10_000 })
      .toBe(0);

    // A line the mentee writes for themselves is not their mentor's to read.
    const mine2 = await page.request.post('/api/todos', { data: { title: `Private note ${stamp}` } });
    expect(mine2.status()).toBe(201);
    await signInAsFreshUser(page, mentorEmail, password, '/mentor');
    const asMentor = await page.request.get(`/api/todos?userId=${mentee.id}`);
    const titles = ((await asMentor.json()).todos as { title: string }[]).map((x) => x.title);
    expect(titles).toContain(fromMentor);
    expect(titles).not.toContain(`Private note ${stamp}`);
  } finally {
    await prisma.projectTask.deleteMany({ where: { assigneeId: mentee.id } });
    await prisma.notification.deleteMany({ where: { userId: { in: [mentor.id, mentee.id] } } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});
