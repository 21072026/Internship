import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, gotoSettled } from './helpers/auth';
import { acceptConfirmDialog } from './helpers/confirm';

/**
 * The session-guide library and its management (#1843, part 2).
 *
 * An admin adds a guide with prompts in several languages, rewords it (the
 * prompts keep their ids, so a session held from the guide follows the new
 * wording), and retires it — archived, not deleted, because held sessions
 * read their prompts from it. A non-admin is refused.
 */

const password = 'AgendaPass123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('an admin can add, reword and retire a session guide; the held session follows the rewording', async ({ page }) => {
  const adminEmail = uniqueEmail('agt-admin');
  const mentorEmail = uniqueEmail('agt-mentor');
  const menteeEmail = uniqueEmail('agt-mentee');
  await seedUser(adminEmail, password, 'ADMIN', 'Agenda Template Admin');
  const mentor = await seedUser(mentorEmail, password, 'MENTOR', 'Agenda Template Mentor');
  const mentee = await seedUser(menteeEmail, password, 'MENTEE', 'Agenda Template Mentee');
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id, status: 'ACTIVE' } });
  const stamp = Date.now();
  const en = `Portfolio review ${stamp}`;
  const tr = `Portfolyo incelemesi ${stamp}`;
  const reworded = `Portfolio review, second pass ${stamp}`;
  let templateId: string | null = null;

  try {
    await signInAndSettle(page, adminEmail, password, '/admin');
    await gotoSettled(page, '/admin/agenda-templates');

    // Add it: title in two languages, a summary, two prompts, one with a note.
    await page.getByTestId('new-agenda-template-en').fill(en);
    await page.getByTestId('new-agenda-template-tr').fill(tr);
    await page.getByTestId('new-agenda-template-summary-en').fill('Before the first application round.');
    await page.getByTestId('new-agenda-template-item-0-en').fill('Which three projects go on the first page?');
    await page.getByTestId('new-agenda-template-item-0-tr').fill('İlk sayfaya hangi üç proje girecek?');
    await page.getByTestId('new-agenda-template-item-0-guidance').fill('Ask for the story behind each one.');
    await page.getByTestId('new-agenda-template-add-item').click();
    await page.getByTestId('new-agenda-template-item-1-en').fill('What is missing for the target role?');
    await page.getByTestId('create-agenda-template').click();

    await expect
      .poll(async () => prisma.agendaTemplate.count({ where: { title: en } }), { timeout: 10_000 })
      .toBe(1);
    const created = await prisma.agendaTemplate.findFirstOrThrow({ where: { title: en }, include: { items: { orderBy: { order: 'asc' } } } });
    templateId = created.id;
    expect(created.translations).toMatchObject({ en, tr });
    expect(created.summary).toMatchObject({ en: 'Before the first application round.' });
    expect(created.items).toHaveLength(2);
    expect(created.items[0].prompt).toBe('Which three projects go on the first page?');
    expect(created.items[0].guidance).toBe('Ask for the story behind each one.');
    expect(created.items[1].guidance).toBeNull();

    const row = page.getByTestId(`agenda-template-${created.id}`);
    await expect(row).toContainText(en);
    await expect(row).toContainText('Which three projects go on the first page?');
    await expect(row).toContainText('2 prompts');

    // The same title twice is refused.
    const dup = await page.request.post('/api/admin/agenda-templates', {
      data: { translations: { en }, items: [{ translations: { en: 'x' } }] },
    });
    expect(dup.status()).toBe(409);

    // A session is held from it before the rewording (seeded the way
    // instantiateAgenda() writes it: one line per prompt, pointing back).
    await prisma.sessionAgenda.create({
      data: {
        relationId: rel.id,
        templateId: created.id,
        createdById: mentor.id,
        items: { create: created.items.map((item, order) => ({ order, text: item.prompt, templateItemId: item.id })) },
      },
    });

    // Reword the English title and the first prompt, drop nothing.
    await page.getByTestId(`edit-agenda-template-${created.id}`).click();
    await page.getByTestId(`edit-agenda-template-${created.id}-en`).fill(reworded);
    await page.getByTestId(`edit-agenda-template-${created.id}-item-0-en`).fill('Which three projects open the portfolio?');
    await page.getByTestId(`save-agenda-template-${created.id}`).click();
    await expect
      .poll(async () => (await prisma.agendaTemplate.findUnique({ where: { id: created.id } }))?.title, { timeout: 10_000 })
      .toBe(reworded);
    const after = await prisma.agendaTemplateItem.findMany({ where: { templateId: created.id }, orderBy: { order: 'asc' } });
    // Same rows, new wording: the held session keeps following them.
    expect(after.map((i) => i.id)).toEqual(created.items.map((i) => i.id));
    expect(after[0].prompt).toBe('Which three projects open the portfolio?');
    const held = await prisma.sessionAgendaItem.findFirst({ where: { templateItemId: created.items[0].id } });
    expect(held).not.toBeNull();

    // The search box is this page's own (AdminNav has one too).
    await page.getByTestId('agenda-template-search').fill('no such guide zzz');
    await expect(page.getByTestId('empty-agenda-templates')).toBeVisible();
    await page.getByTestId('agenda-template-search').fill(String(stamp));
    await expect(page.getByTestId(`agenda-template-${created.id}`)).toBeVisible();

    // Retire it: archived, not deleted; gone from the library; the held
    // session still has its lines.
    await page.getByTestId(`delete-agenda-template-${created.id}`).click();
    await acceptConfirmDialog(page);
    await expect
      .poll(async () => (await prisma.agendaTemplate.findUnique({ where: { id: created.id } }))?.archivedAt !== null, { timeout: 10_000 })
      .toBe(true);
    const library = await page.request.get('/api/admin/agenda-templates');
    expect(((await library.json()).templates as { id: string }[]).some((x) => x.id === created.id)).toBeFalsy();
    expect(await prisma.sessionAgendaItem.count({ where: { templateItemId: created.items[0].id } })).toBe(1);

    // Re-adding the retired title revives the same row.
    const revive = await page.request.post('/api/admin/agenda-templates', {
      data: { translations: { en: reworded }, items: [{ translations: { en: 'Revived prompt' } }] },
    });
    expect(revive.status()).toBe(201);
    expect(((await revive.json()).template as { id: string }).id).toBe(created.id);
    expect((await prisma.agendaTemplate.findUniqueOrThrow({ where: { id: created.id } })).archivedAt).toBeNull();
  } finally {
    await prisma.sessionAgenda.deleteMany({ where: { relationId: rel.id } });
    if (templateId) await prisma.agendaTemplate.deleteMany({ where: { id: templateId } });
    await prisma.agendaTemplate.deleteMany({ where: { title: { in: [en, reworded] } } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  }
});

test('the library is admin-only', async ({ page }) => {
  const mentorEmail = uniqueEmail('agt-mentor-only');
  await seedUser(mentorEmail, password, 'MENTOR', 'Not An Admin');
  try {
    await signInAndSettle(page, mentorEmail, password, '/mentor');
    expect((await page.request.get('/api/admin/agenda-templates')).status()).toBe(401);
    expect((await page.request.post('/api/admin/agenda-templates', { data: { translations: { en: 'x' }, items: [{ translations: { en: 'y' } }] } })).status()).toBe(401);
    expect((await page.request.delete('/api/admin/agenda-templates', { data: { id: 'nope' } })).status()).toBe(401);
  } finally {
    await cleanupByEmail(mentorEmail);
  }
});
