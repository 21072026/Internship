import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInViaApi, signInAndSettle, gotoSettled } from './helpers/auth';

// A goal's steps ARE to-dos, and goals use the trilingual pool (#1860).
//   - a step lands on its assignee's /todos list; ticking it there moves the
//     goal's derived progress, and the mentor may tick it too;
//   - deleting the goal leaves its steps intact, on the list, goal-less;
//   - a pooled goal reads in the reader's language, and its recipient can
//     neither reword nor delete it;
//   - the panel shows the steps and the derived progress.

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function seedPair(prefix: string) {
  const mentorEmail = uniqueEmail(`${prefix}-mentor`);
  const menteeEmail = uniqueEmail(`${prefix}-mentee`);
  const mentor = await seedUser(mentorEmail, 'Pass1234!', 'MENTOR', 'Steps Mentor');
  const mentee = await seedUser(menteeEmail, 'Pass1234!', 'MENTEE', 'Steps Mentee');
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id, status: 'ACTIVE' } });
  const cleanup = async () => {
    await prisma.projectTask.deleteMany({ where: { OR: [{ assigneeId: { in: [mentor.id, mentee.id] } }, { createdById: { in: [mentor.id, mentee.id] } }] } });
    await prisma.goal.deleteMany({ where: { relationId: rel.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  };
  return { mentorEmail, menteeEmail, mentor, mentee, rel, cleanup };
}

test('goal → step → tick on /todos → derived progress; deleting the goal keeps its steps', { tag: '@smoke' }, async ({ playwright }) => {
  const p = await seedPair('goal-steps');
  const asMentee = await playwright.request.newContext();
  const asMentor = await playwright.request.newContext();
  try {
    expect((await signInViaApi(asMentee, p.menteeEmail, 'Pass1234!')).ok).toBeTruthy();
    expect((await signInViaApi(asMentor, p.mentorEmail, 'Pass1234!')).ok).toBeTruthy();

    const goal = (await (await asMentor.post('/api/goals', { data: { relationId: p.rel.id, title: 'Land a first role', progress: 70 } })).json()).goal;
    const step = async (title: string, by = asMentor) => {
      const res = await by.post(`/api/goals/${goal.id}/subtasks`, { data: { title } });
      expect(res.status(), await res.text()).toBe(201);
      return (await res.json()).task as { id: string; assigneeId: string };
    };
    const cv = await step('Rewrite the CV');
    const apply = await step('Send five applications');
    const own = await step('Ask a friend for a mock interview', asMentee);
    expect(cv.assigneeId).toBe(p.mentee.id);

    const read = async () => ((await (await asMentee.get(`/api/goals?relationId=${p.rel.id}`)).json()).goals as { id: string; progress: number; manualProgress: number; subtasks: { id: string; done: boolean }[] }[])[0];
    // With steps, the progress is theirs — not the 70 typed by hand.
    expect((await read()).progress).toBe(0);
    expect((await read()).manualProgress).toBe(70);

    // The step is a to-do on the mentee's own list…
    const todos = (await (await asMentee.get('/api/todos')).json()).todos as { id: string }[];
    expect(todos.map((x) => x.id)).toEqual(expect.arrayContaining([cv.id, apply.id, own.id]));
    // …ticking it there moves the goal.
    expect((await asMentee.patch(`/api/project-tasks/${cv.id}`, { data: { done: true } })).status()).toBe(200);
    expect((await read()).progress).toBe(33);
    // The mentor ticks a step the mentee wrote and holds: the goal's reader may.
    expect((await asMentor.patch(`/api/project-tasks/${own.id}`, { data: { done: true } })).status()).toBe(200);
    expect((await read()).progress).toBe(67);
    // …but cannot delete it or reword it: it is the mentee's own line.
    expect((await asMentor.delete(`/api/project-tasks/${own.id}`)).status()).toBe(403);

    // Deleting the goal leaves the work done under it.
    expect((await asMentor.delete(`/api/goals/${goal.id}`)).status()).toBe(200);
    const kept = await prisma.projectTask.findMany({ where: { id: { in: [cv.id, apply.id, own.id] } } });
    expect(kept).toHaveLength(3);
    expect(kept.every((k) => k.goalId === null)).toBe(true);
  } finally {
    await Promise.all([asMentee.dispose(), asMentor.dispose()]);
    await p.cleanup();
  }
});

test('a pooled goal reads in the reader\'s language and is not its recipient\'s to reword or delete', { tag: '@smoke' }, async ({ playwright }) => {
  const p = await seedPair('goal-pool');
  await prisma.user.update({ where: { id: p.mentee.id }, data: { preferredLanguage: 'de' } });
  const template = await prisma.projectTaskTemplate.create({
    data: { title: `Build a portfolio ${Date.now()}`, translations: { en: 'Build a portfolio', de: 'Ein Portfolio aufbauen', tr: 'Bir portfolyo oluştur' } },
  });
  const asMentee = await playwright.request.newContext();
  const asMentor = await playwright.request.newContext();
  try {
    expect((await signInViaApi(asMentee, p.menteeEmail, 'Pass1234!')).ok).toBeTruthy();
    expect((await signInViaApi(asMentor, p.mentorEmail, 'Pass1234!')).ok).toBeTruthy();

    // The mentee does not hand themselves a pooled goal.
    expect((await asMentee.post('/api/goals', { data: { relationId: p.rel.id, templateId: template.id } })).status()).toBe(403);
    const created = await asMentor.post('/api/goals', { data: { relationId: p.rel.id, templateId: template.id } });
    expect(created.status(), await created.text()).toBe(201);
    const goalId = (await created.json()).goal.id as string;

    const asRead = (await (await asMentee.get(`/api/goals?relationId=${p.rel.id}`)).json()).goals[0];
    expect(asRead.title).toBe('Ein Portfolio aufbauen');
    expect(asRead.canReword).toBe(false);
    expect(asRead.canDelete).toBe(false);

    const reword = await asMentee.patch(`/api/goals/${goalId}`, { data: { title: 'Something else' } });
    expect(reword.status()).toBe(409);
    expect((await reword.json()).code).toBe('pooled_goal');
    expect((await asMentee.delete(`/api/goals/${goalId}`)).status()).toBe(403);
    // Ticking it is still the mentee's to do.
    expect((await asMentee.patch(`/api/goals/${goalId}`, { data: { status: 'DONE' } })).status()).toBe(200);
    // Whoever handed it out may take it back.
    expect((await asMentor.delete(`/api/goals/${goalId}`)).status()).toBe(200);
    expect((await prisma.projectTaskTemplate.findUnique({ where: { id: template.id } }))?.useCount).toBe(1);
  } finally {
    await Promise.all([asMentee.dispose(), asMentor.dispose()]);
    await p.cleanup();
    await prisma.projectTaskTemplate.deleteMany({ where: { id: template.id } });
  }
});

test('the goals panel shows the steps and the progress they derive', async ({ page }) => {
  const p = await seedPair('goal-steps-ui');
  try {
    const goal = await prisma.goal.create({ data: { relationId: p.rel.id, title: 'Ship a side project', createdByRole: 'MENTOR', createdById: p.mentor.id } });
    await prisma.projectTask.createMany({
      data: [
        { title: 'Pick the idea', goalId: goal.id, assigneeId: p.mentee.id, createdById: p.mentor.id, done: true, doneAt: new Date() },
        { title: 'Write the README', goalId: goal.id, assigneeId: p.mentee.id, createdById: p.mentor.id },
      ],
    });
    await signInAndSettle(page, p.menteeEmail, 'Pass1234!', '/portal');
    await gotoSettled(page, '/portal/goals');
    const card = page.getByTestId(`goal-${goal.id}`);
    await expect(card.getByTestId(`goalsteps-${goal.id}`).getByText('Write the README', { exact: true })).toBeVisible();
    await expect(card.getByTestId('goal-progress-value')).toContainText('50');
    await card.getByTestId(`goalstep-input-${goal.id}`).fill('Deploy it');
    await card.getByTestId(`goalstep-add-${goal.id}`).click();
    await expect(card.getByText('Deploy it', { exact: true })).toBeVisible();
    await expect(card.getByTestId('goal-progress-value')).toContainText('33');
  } finally {
    await p.cleanup();
  }
});
