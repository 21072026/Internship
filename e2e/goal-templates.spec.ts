import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, signInAsFreshUser, gotoSettled } from './helpers/auth';
import { acceptConfirmDialog } from './helpers/confirm';

/**
 * The shared goal-template pool and its management (#51 follow-up).
 *
 * Two things this locks down: an admin can add / reword / retire a shared
 * template, and a goal handed out from the pool reaches the person in *their*
 * language. Since #1113 the to-do keeps a *reference* to the template, so the
 * wording is resolved per reader rather than copied once — and retiring a
 * template archives it instead of deleting it, because the people who already
 * have it read their wording from it.
 */

const password = 'TemplatePass123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('an admin can add, reword and retire a shared goal template', async ({ page }) => {
  const adminEmail = uniqueEmail('gt-admin');
  await seedUser(adminEmail, password, 'ADMIN', 'Goal Template Admin');
  const stamp = Date.now();
  const en = `Read the deploy script ${stamp}`;
  const tr = `Deploy betiğini oku ${stamp}`;
  const reworded = `Read the deploy script carefully ${stamp}`;

  try {
    await signInAndSettle(page, adminEmail, password, '/admin');
    await gotoSettled(page, '/admin/goal-templates');

    // Add it in two of the three languages.
    await page.getByTestId('new-template-en').fill(en);
    await page.getByTestId('new-template-tr').fill(tr);
    await page.getByTestId('create-template').click();

    await expect
      .poll(async () => prisma.projectTaskTemplate.count({ where: { projectId: null, title: en } }), { timeout: 10_000 })
      .toBe(1);
    const created = await prisma.projectTaskTemplate.findFirstOrThrow({ where: { projectId: null, title: en } });
    // The canonical title is the default locale's wording, both languages stored.
    expect(created.translations).toMatchObject({ en, tr });

    const row = page.getByTestId(`goal-template-${created.id}`);
    await expect(row).toContainText(en);
    // The other language is shown alongside, so an admin can see what is missing.
    await expect(row).toContainText(tr);

    // Reword the English side.
    await page.getByTestId(`edit-template-${created.id}`).click();
    await page.getByTestId(`edit-template-${created.id}-en`).fill(reworded);
    await page.getByTestId(`save-template-${created.id}`).click();
    await expect
      .poll(async () => (await prisma.projectTaskTemplate.findUnique({ where: { id: created.id } }))?.title, {
        timeout: 10_000,
      })
      .toBe(reworded);

    // And retire it: the row is archived, not deleted — the to-dos handed out
    // from it read their wording here — but it leaves the pool.
    await page.getByTestId(`delete-template-${created.id}`).click();
    await acceptConfirmDialog(page);
    await expect
      .poll(
        async () =>
          (await prisma.projectTaskTemplate.findUnique({ where: { id: created.id } }))?.archivedAt !== null,
        { timeout: 10_000 }
      )
      .toBe(true);
    const pool = await page.request.get('/api/admin/goal-templates');
    expect(
      ((await pool.json()).templates as { id: string }[]).some((x) => x.id === created.id)
    ).toBeFalsy();
  } finally {
    await prisma.projectTaskTemplate.deleteMany({ where: { projectId: null, title: { in: [en, reworded] } } });
    await cleanupByEmail(adminEmail);
  }
});

test('a lead can tick the whole template pool at once and hand it over', async ({ page }) => {
  const mentorEmail = uniqueEmail('gt-all-mentor');
  const menteeEmail = uniqueEmail('gt-all-mentee');
  const mentor = await seedUser(mentorEmail, password, 'MENTOR', 'Select All Mentor');
  const mentee = await seedUser(menteeEmail, password, 'MENTEE', 'Select All Mentee');
  const stamp = Date.now();

  const project = await prisma.project.create({
    data: {
      name: `Select All Project ${stamp}`,
      ownerType: 'MENTOR',
      ownerUserId: mentor.id,
      members: {
        create: [
          { userId: mentor.id, role: 'OWNER' },
          { userId: mentee.id, role: 'MENTEE' },
        ],
      },
      taskTemplates: {
        create: [
          { title: `Set up the dev database ${stamp}`, translations: { en: `Set up the dev database ${stamp}` } },
          { title: `Write the first test ${stamp}`, translations: { en: `Write the first test ${stamp}` } },
        ],
      },
    },
  });

  try {
    await signInAndSettle(page, mentorEmail, password, '/mentor');
    await gotoSettled(page, `/projects/${project.id}`);
    await page.getByTestId('toggle-templates').click();

    // Whatever the pool holds here: this project's two plus every shared one.
    const pool = await page.request.get(`/api/projects/${project.id}/task-templates`);
    const ids = ((await pool.json()).templates as { id: string }[]).map((x) => x.id);
    expect(ids.length).toBeGreaterThanOrEqual(2);

    // The control is there before anything is ticked — that is the whole point
    // of it; it used to appear only once a box was already checked.
    const selectAll = page.getByTestId('select-all-templates');
    await expect(selectAll).toBeVisible();
    await expect(selectAll).not.toBeChecked();

    await selectAll.check();
    for (const id of ids) await expect(page.getByTestId(`template-${id}`)).toBeChecked();
    await expect(page.getByTestId('templates-picked-count')).toContainText(String(ids.length));

    // Ticked-all flips it into a clear-the-selection control.
    await selectAll.uncheck();
    for (const id of ids) await expect(page.getByTestId(`template-${id}`)).not.toBeChecked();
    await expect(page.getByTestId('templates-picked-count')).toHaveCount(0);

    // And the whole shortlist goes over in one send.
    await selectAll.check();
    await page.getByTestId('template-target').selectOption(mentee.id);
    await page.getByTestId('send-templates').click();
    await expect
      .poll(async () => prisma.projectTask.count({ where: { projectId: project.id, assigneeId: mentee.id } }), {
        timeout: 10_000,
      })
      .toBe(ids.length);
  } finally {
    await prisma.projectTask.deleteMany({ where: { projectId: project.id } });
    await prisma.projectTaskTemplate.deleteMany({ where: { projectId: project.id } });
    await prisma.notification.deleteMany({ where: { userId: { in: [mentor.id, mentee.id] } } });
    await prisma.projectMember.deleteMany({ where: { projectId: project.id } });
    await prisma.conversation.deleteMany({ where: { projectId: project.id } });
    await prisma.project.delete({ where: { id: project.id } }).catch(() => {});
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});

test('a goal sent from the pool reaches the mentee in their own language', async ({ page }) => {
  const mentorEmail = uniqueEmail('gt-mentor');
  const menteeEmail = uniqueEmail('gt-mentee');
  const mentor = await seedUser(mentorEmail, password, 'MENTOR', 'Template Mentor');
  const mentee = await seedUser(menteeEmail, password, 'MENTEE', 'Template Mentee');
  // The mentee reads the app in Turkish, so that is the wording they should get.
  await prisma.user.update({ where: { id: mentee.id }, data: { preferredLanguage: 'tr' } });

  const stamp = Date.now();
  const en = `Write the integration test ${stamp}`;
  const tr = `Entegrasyon testini yaz ${stamp}`;
  const template = await prisma.projectTaskTemplate.create({
    data: { projectId: null, title: en, translations: { en, tr } },
  });

  const project = await prisma.project.create({
    data: {
      name: `Template Project ${stamp}`,
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

    // The shared template is in this project's pool …
    const pool = await page.request.get(`/api/projects/${project.id}/task-templates`);
    expect(pool.ok()).toBeTruthy();
    const listed = (await pool.json()).templates.find((x: { id: string }) => x.id === template.id);
    expect(listed).toMatchObject({ shared: true, translations: { en, tr } });

    // … and handing it over creates the goal in the mentee's language.
    const sent = await page.request.post(`/api/projects/${project.id}/tasks`, {
      data: { templateIds: [template.id], assigneeId: mentee.id },
    });
    expect(sent.status()).toBe(201);

    // The row references the template rather than copying its wording: that is
    // what lets a later edit reach everyone, in each of their languages.
    const task = await prisma.projectTask.findFirstOrThrow({ where: { projectId: project.id, assigneeId: mentee.id } });
    expect(task.templateId).toBe(template.id);
    expect(task.title).toBe(en); // the snapshot is canonical; the reader sees theirs

    // Sending a shared template does not clone it into the project's own pool —
    // and neither does handing a to-do out at all (#1113).
    expect(await prisma.projectTaskTemplate.count({ where: { projectId: project.id } })).toBe(0);

    // The mentee reads it in Turkish on their own to-do list.
    await signInAsFreshUser(page, menteeEmail, password, '/portal');
    await gotoSettled(page, '/todos');
    await expect(page.getByTestId(`todo-${task.id}`)).toContainText(tr);
  } finally {
    await prisma.projectTask.deleteMany({ where: { projectId: project.id } });
    await prisma.projectTaskTemplate.deleteMany({ where: { projectId: project.id } });
    await prisma.projectTaskTemplate.deleteMany({ where: { id: template.id } });
    await prisma.notification.deleteMany({ where: { userId: { in: [mentor.id, mentee.id] } } });
    await prisma.projectMember.deleteMany({ where: { projectId: project.id } });
    await prisma.conversation.deleteMany({ where: { projectId: project.id } });
    await prisma.project.delete({ where: { id: project.id } }).catch(() => {});
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});
