import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInViaApi, signInAndSettle } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #1843: a session agenda is picked from the guide library, ticked by either
// side, and its unfinished lines carry into the next session. The first test
// is the boundary (hence @smoke): the relation rule server-side — a third
// party's PATCH is 403, an archived mentorship answers the existing 409 —
// plus the loop pick → tick → carry-over through the API. The second drives
// the panel.

const PASSWORD = 'Pass1234!';

async function seedPair(prefix: string) {
  const mentorEmail = uniqueEmail(`${prefix}-mentor`);
  const menteeEmail = uniqueEmail(`${prefix}-mentee`);
  const strangerEmail = uniqueEmail(`${prefix}-stranger`);
  const mentor = await seedUser(mentorEmail, PASSWORD, 'MENTOR', 'Agenda Mentor');
  const mentee = await seedUser(menteeEmail, PASSWORD, 'MENTEE', 'Agenda Mentee');
  const stranger = await seedUser(strangerEmail, PASSWORD, 'MENTOR', 'Agenda Stranger');
  const rel = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, status: 'ACTIVE' },
  });
  const stamp = Date.now();
  const template = await prisma.agendaTemplate.create({
    data: {
      title: `E2E kickoff ${stamp}`,
      translations: { en: `E2E kickoff ${stamp}`, tr: `E2E tanışma ${stamp}`, de: `E2E Auftakt ${stamp}` },
      items: {
        create: [
          { order: 0, prompt: 'Introduce yourselves', translations: { en: 'Introduce yourselves', tr: 'Kendinizi tanıtın' }, guidance: 'Go first.' },
          { order: 1, prompt: 'What do you hope for?', translations: { en: 'What do you hope for?', tr: 'Ne bekliyorsun?' } },
          { order: 2, prompt: 'How will we work together?', translations: { en: 'How will we work together?' } },
        ],
      },
    },
    include: { items: { orderBy: { order: 'asc' } } },
  });
  const cleanup = async () => {
    await prisma.sessionAgenda.deleteMany({ where: { relationId: rel.id } });
    await prisma.agendaTemplate.deleteMany({ where: { id: template.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(strangerEmail);
  };
  return { mentorEmail, menteeEmail, strangerEmail, mentor, mentee, stranger, rel, template, cleanup };
}

type Item = { id: string; done: boolean; carried: boolean; templateItem: { id: string; guidance: string | null } | null; text: string };

test(
  'pick a guide, tick from either side, carry the rest over; a third party is refused and an archive answers 409',
  { tag: '@smoke' },
  async ({ playwright }) => {
    const p = await seedPair('agenda');
    const asMentor = await playwright.request.newContext();
    const asMentee = await playwright.request.newContext();
    const asStranger = await playwright.request.newContext();
    try {
      expect((await signInViaApi(asMentor, p.mentorEmail, PASSWORD)).ok).toBeTruthy();
      expect((await signInViaApi(asMentee, p.menteeEmail, PASSWORD)).ok).toBeTruthy();
      expect((await signInViaApi(asStranger, p.strangerEmail, PASSWORD)).ok).toBeTruthy();

      // The picker lists the guide with its prompts.
      const library = await asMentor.get('/api/agendas/templates');
      expect(library.status()).toBe(200);
      const listed = ((await library.json()).templates as { id: string; items: unknown[] }[]).find((t) => t.id === p.template.id);
      expect(listed?.items).toHaveLength(3);

      // The mentor starts the session from the guide.
      const started = await asMentor.post('/api/agendas', { data: { relationId: p.rel.id, templateId: p.template.id } });
      expect(started.status()).toBe(201);
      const agenda = (await started.json()).agenda as { id: string; templateId: string; items: Item[] };
      expect(agenda.templateId).toBe(p.template.id);
      expect(agenda.items).toHaveLength(3);
      expect(agenda.items.map((i) => i.templateItem?.id)).toEqual(p.template.items.map((i) => i.id));
      // The mentor sees the facilitation note…
      expect(agenda.items[0].templateItem?.guidance).toBe('Go first.');
      expect((await prisma.agendaTemplate.findUniqueOrThrow({ where: { id: p.template.id } })).useCount).toBe(1);

      // …the mentee sees the identical list, without the note.
      const menteeView = await asMentee.get(`/api/agendas?relationId=${p.rel.id}`);
      expect(menteeView.status()).toBe(200);
      const menteeBody = (await menteeView.json()) as { agendas: { id: string; items: Item[] }[]; writable: boolean };
      expect(menteeBody.writable).toBe(true);
      expect(menteeBody.agendas[0].id).toBe(agenda.id);
      expect(menteeBody.agendas[0].items.map((i) => i.id)).toEqual(agenda.items.map((i) => i.id));
      expect(menteeBody.agendas[0].items[0].templateItem?.guidance).toBeNull();

      // A third party is refused on read and on every write — the relation
      // rule, server-side.
      expect((await asStranger.get(`/api/agendas?relationId=${p.rel.id}`)).status()).toBe(403);
      expect((await asStranger.get(`/api/agendas/${agenda.id}`)).status()).toBe(403);
      expect((await asStranger.patch(`/api/agendas/${agenda.id}/items/${agenda.items[0].id}`, { data: { done: true } })).status()).toBe(403);
      expect((await asStranger.post(`/api/agendas/${agenda.id}/items`, { data: { text: 'planted' } })).status()).toBe(403);
      expect((await asStranger.post(`/api/agendas/${agenda.id}/carry-over`, { data: {} })).status()).toBe(403);
      expect((await asStranger.delete(`/api/agendas/${agenda.id}`)).status()).toBe(403);
      expect((await prisma.sessionAgendaItem.findUniqueOrThrow({ where: { id: agenda.items[0].id } })).done).toBe(false);

      // The mentee ticks one, the mentor adds an ad-hoc line and ticks another.
      const ticked = await asMentee.patch(`/api/agendas/${agenda.id}/items/${agenda.items[0].id}`, { data: { done: true } });
      expect(ticked.status()).toBe(200);
      const added = await asMentor.post(`/api/agendas/${agenda.id}/items`, { data: { text: 'Visa appointment on the 14th' } });
      expect(added.status()).toBe(201);
      expect((await asMentor.patch(`/api/agendas/${agenda.id}/items/${agenda.items[1].id}`, { data: { done: true } })).status()).toBe(200);
      // A templated line keeps the guide's wording.
      const reword = await asMentor.patch(`/api/agendas/${agenda.id}/items/${agenda.items[2].id}`, { data: { text: 'nope' } });
      expect(reword.status()).toBe(400);
      expect((await reword.json()).code).toBe('templated');
      // An item id of this agenda is only reachable through this agenda.
      const other = await asMentor.post('/api/agendas', { data: { relationId: p.rel.id } });
      const otherId = ((await other.json()).agenda as { id: string }).id;
      expect((await asMentor.patch(`/api/agendas/${otherId}/items/${agenda.items[2].id}`, { data: { done: true } })).status()).toBe(404);
      expect((await asMentor.delete(`/api/agendas/${otherId}`)).status()).toBe(200);

      const afterTicks = ((await (await asMentor.get(`/api/agendas/${agenda.id}`)).json()).agenda as { items: Item[] }).items;
      expect(afterTicks).toHaveLength(4);
      expect(afterTicks.filter((i) => i.done)).toHaveLength(2);

      // Carry-over: the two open lines move into a fresh agenda, marked.
      const carried = await asMentee.post(`/api/agendas/${agenda.id}/carry-over`, { data: {} });
      expect(carried.status()).toBe(201);
      const next = (await carried.json()) as { agenda: { id: string; templateId: string | null; items: Item[] }; carried: number };
      expect(next.carried).toBe(2);
      expect(next.agenda.id).not.toBe(agenda.id);
      expect(next.agenda.templateId).toBeNull();
      expect(next.agenda.items).toHaveLength(2);
      expect(next.agenda.items.every((i) => i.carried && !i.done)).toBe(true);
      // The templated line still reads the guide; the ad-hoc one its own text.
      expect(next.agenda.items[0].templateItem?.id).toBe(p.template.items[2].id);
      expect(next.agenda.items[1].text).toBe('Visa appointment on the 14th');
      const stored = await prisma.sessionAgendaItem.findMany({ where: { agendaId: next.agenda.id }, orderBy: { order: 'asc' } });
      expect(stored.map((s) => s.carriedFromItemId)).toEqual([agenda.items[2].id, afterTicks[3].id]);
      // The source session is untouched — it is the record of that session.
      expect(await prisma.sessionAgendaItem.count({ where: { agendaId: agenda.id } })).toBe(4);
      // Nothing left to carry from the new one once ticked.
      for (const item of next.agenda.items) {
        await asMentor.patch(`/api/agendas/${next.agenda.id}/items/${item.id}`, { data: { done: true } });
      }
      const empty = await asMentor.post(`/api/agendas/${next.agenda.id}/carry-over`, { data: {} });
      expect(empty.status()).toBe(400);
      expect((await empty.json()).code).toBe('nothing_to_carry');

      // Retiring the guide never blanks a held agenda.
      await prisma.agendaTemplate.update({ where: { id: p.template.id }, data: { archivedAt: new Date() } });
      const held = ((await (await asMentee.get(`/api/agendas/${agenda.id}`)).json()).agenda as { template: { archived: boolean }; items: Item[] });
      expect(held.template.archived).toBe(true);
      expect(held.items[0].templateItem?.id).toBe(p.template.items[0].id);
      // …and is not offered again.
      expect((await asMentor.post('/api/agendas', { data: { relationId: p.rel.id, templateId: p.template.id } })).status()).toBe(404);

      // An archived mentorship: the mentee reads, cannot write (409
      // inactive_relation), the mentor still can.
      await prisma.mentorshipRelation.update({ where: { id: p.rel.id }, data: { status: 'COMPLETED', completedAt: new Date() } });
      const readOnly = (await (await asMentee.get(`/api/agendas?relationId=${p.rel.id}`)).json()) as { writable: boolean; agendas: unknown[] };
      expect(readOnly.writable).toBe(false);
      expect(readOnly.agendas).toHaveLength(2);
      const locked = await asMentee.post('/api/agendas', { data: { relationId: p.rel.id } });
      expect(locked.status()).toBe(409);
      expect((await locked.json()).code).toBe('inactive_relation');
      const lockedTick = await asMentee.patch(`/api/agendas/${agenda.id}/items/${agenda.items[2].id}`, { data: { done: true } });
      expect(lockedTick.status()).toBe(409);
      expect((await lockedTick.json()).code).toBe('inactive_relation');
      expect((await asMentor.patch(`/api/agendas/${agenda.id}/items/${agenda.items[2].id}`, { data: { done: true } })).status()).toBe(200);
    } finally {
      await asMentor.dispose();
      await asMentee.dispose();
      await asStranger.dispose();
      await p.cleanup();
    }
  }
);

test('the panel starts a session from a guide, ticks a line and carries the rest forward', async ({ page }) => {
  const p = await seedPair('agenda-ui');
  try {
    await signInAndSettle(page, p.mentorEmail, PASSWORD, '/mentor');
    await page.goto(`/mentor/mentees/${p.rel.id}`);
    const panel = page.getByTestId('agenda-panel');
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await expect(panel).toContainText('No agenda yet');

    await panel.getByTestId('agenda-template-picker').selectOption(p.template.id);
    await panel.getByTestId('agenda-start').click();
    const items = panel.getByTestId('agenda-items').locator('li');
    await expect(items).toHaveCount(3, { timeout: 10_000 });
    await expect(panel.getByTestId('agenda-source')).toContainText(`E2E kickoff`);
    await expect(items.first()).toContainText('Introduce yourselves');
    // The mentor's facilitation note is shown under the prompt.
    await expect(panel.getByTestId('agenda-guidance').first()).toContainText('Go first.');

    const agenda = await prisma.sessionAgenda.findFirstOrThrow({ where: { relationId: p.rel.id }, include: { items: { orderBy: { order: 'asc' } } } });
    await panel.getByTestId(`agenda-item-toggle-${agenda.items[0].id}`).click();
    await expect(panel.getByTestId('agenda-progress')).toContainText('1 of 3 done', { timeout: 10_000 });
    await expect.poll(async () => (await prisma.sessionAgendaItem.findUniqueOrThrow({ where: { id: agenda.items[0].id } })).done).toBe(true);

    // An ad-hoc line.
    await panel.getByTestId('agenda-add-input').fill('Bring the portfolio link');
    await panel.getByTestId('agenda-add').click();
    await expect(items).toHaveCount(4, { timeout: 10_000 });
    await expect(panel.getByTestId('agenda-progress')).toContainText('1 of 4 done');

    // Carry the three open lines into the next session.
    await panel.getByTestId('agenda-template-picker').selectOption('');
    await panel.getByTestId('agenda-carry-over').click();
    await expect(panel.getByTestId('agenda-carried-badge')).toHaveCount(3, { timeout: 10_000 });
    await expect(panel.getByTestId('agenda-source')).toContainText('Free-form agenda');
    await expect(panel.getByTestId('agenda-session-select')).toBeVisible();
    expect(await prisma.sessionAgenda.count({ where: { relationId: p.rel.id } })).toBe(2);
  } finally {
    await p.cleanup();
  }
});
