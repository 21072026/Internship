import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInViaApi, signInAndSettle } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #1858: a goal carries success criteria, a target date, a progress figure
// and a sharing scope — and the scope is enforced by the ROUTES, not by the
// panel. The first test is the authorization boundary (hence @smoke, like the
// other security guards): a PRIVATE goal must be absent from the other
// participant's and the admin's GET, and its id must answer like a missing
// one on PATCH/DELETE. The second covers the rendering.

async function seedPair(prefix: string) {
  const mentorEmail = uniqueEmail(`${prefix}-mentor`);
  const menteeEmail = uniqueEmail(`${prefix}-mentee`);
  const adminEmail = uniqueEmail(`${prefix}-admin`);
  const mentor = await seedUser(mentorEmail, 'Pass1234!', 'MENTOR', 'Depth Mentor');
  const mentee = await seedUser(menteeEmail, 'Pass1234!', 'MENTEE', 'Depth Mentee');
  const admin = await seedUser(adminEmail, 'Pass1234!', 'ADMIN', 'Depth Admin');
  const rel = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, status: 'ACTIVE' },
  });
  const cleanup = async () => {
    await prisma.goal.deleteMany({ where: { relationId: rel.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  };
  return { mentorEmail, menteeEmail, adminEmail, mentor, mentee, admin, rel, cleanup };
}

test(
  'a PRIVATE goal is invisible and unwritable to the other side and to admins; the scope is the author\'s',
  { tag: '@smoke' },
  async ({ playwright }) => {
    const p = await seedPair('goal-depth');
    const asMentee = await playwright.request.newContext();
    const asMentor = await playwright.request.newContext();
    const asAdmin = await playwright.request.newContext();
    try {
      expect((await signInViaApi(asMentee, p.menteeEmail, 'Pass1234!')).ok).toBeTruthy();
      expect((await signInViaApi(asMentor, p.mentorEmail, 'Pass1234!')).ok).toBeTruthy();
      expect((await signInViaApi(asAdmin, p.adminEmail, 'Pass1234!')).ok).toBeTruthy();

      // The mentee writes one private and one shared goal, with the new depth.
      const privateRes = await asMentee.post('/api/goals', {
        data: {
          relationId: p.rel.id,
          title: 'Private: move out of my parents flat',
          successCriteria: 'Signed lease in hand',
          targetDate: '2026-12-01',
          progress: 25,
          visibility: 'PRIVATE',
        },
      });
      expect(privateRes.status()).toBe(201);
      const privateGoal = (await privateRes.json()).goal;
      expect(privateGoal.visibility).toBe('PRIVATE');
      expect(privateGoal.successCriteria).toBe('Signed lease in hand');
      expect(privateGoal.progress).toBe(25);
      expect(privateGoal.targetDate).toContain('2026-12-01');
      expect(privateGoal.createdById).toBe(p.mentee.id);

      const sharedRes = await asMentee.post('/api/goals', {
        data: { relationId: p.rel.id, title: 'Shared: finish the CV' },
      });
      expect(sharedRes.status()).toBe(201);
      const sharedGoal = (await sharedRes.json()).goal;
      expect(sharedGoal.visibility).toBe('PAIR');

      // The author sees both…
      const mine = (await (await asMentee.get(`/api/goals?relationId=${p.rel.id}`)).json()).goals as { id: string }[];
      expect(mine.map((g) => g.id).sort()).toEqual([privateGoal.id, sharedGoal.id].sort());

      // …the mentor and the admin see only the shared one — the API answer,
      // not a hidden card.
      for (const ctx of [asMentor, asAdmin]) {
        const res = await ctx.get(`/api/goals?relationId=${p.rel.id}`);
        expect(res.status()).toBe(200);
        const ids = ((await res.json()).goals as { id: string }[]).map((g) => g.id);
        expect(ids).toEqual([sharedGoal.id]);
      }

      // A PRIVATE id answers like a missing one on PATCH and DELETE — 404, the
      // same answer a goal of another tenant gets, so nothing is confirmed.
      for (const ctx of [asMentor, asAdmin]) {
        expect((await ctx.patch(`/api/goals/${privateGoal.id}`, { data: { title: 'pwned' } })).status()).toBe(404);
        expect((await ctx.delete(`/api/goals/${privateGoal.id}`)).status()).toBe(404);
      }
      const untouched = await prisma.goal.findUnique({ where: { id: privateGoal.id } });
      expect(untouched?.title).toBe('Private: move out of my parents flat');

      // The mentor may tick and edit the shared goal, but not change who reads it.
      expect((await asMentor.patch(`/api/goals/${sharedGoal.id}`, { data: { progress: 50 } })).status()).toBe(200);
      const notAuthor = await asMentor.patch(`/api/goals/${sharedGoal.id}`, { data: { visibility: 'PRIVATE' } });
      expect(notAuthor.status()).toBe(403);
      expect((await notAuthor.json()).code).toBe('not_author');
      // Sending the current scope unchanged is a no-op for everybody.
      expect((await asMentor.patch(`/api/goals/${sharedGoal.id}`, { data: { visibility: 'PAIR', title: 'Shared: finish the CV v2' } })).status()).toBe(200);
      expect((await prisma.goal.findUnique({ where: { id: sharedGoal.id } }))?.visibility).toBe('PAIR');

      // The author narrows it, and the mentor's view loses it at once.
      expect((await asMentee.patch(`/api/goals/${sharedGoal.id}`, { data: { visibility: 'PRIVATE' } })).status()).toBe(200);
      const afterNarrow = ((await (await asMentor.get(`/api/goals?relationId=${p.rel.id}`)).json()).goals as unknown[]);
      expect(afterNarrow).toEqual([]);

      // The timeline reads through the same rule.
      const timeline = await asMentor.get(`/api/mentorship/${p.rel.id}/timeline?kinds=goal`);
      expect(timeline.status()).toBe(200);
      expect(((await timeline.json()).entries as { kind: string }[]).filter((e) => e.kind === 'goal')).toEqual([]);
      const ownTimeline = await asMentee.get(`/api/mentorship/${p.rel.id}/timeline?kinds=goal`);
      expect(((await ownTimeline.json()).entries as { kind: string }[]).filter((e) => e.kind === 'goal')).toHaveLength(2);

      // Validation: progress outside 0–100 and an unknown scope are refused.
      expect((await asMentee.patch(`/api/goals/${privateGoal.id}`, { data: { progress: 101 } })).status()).toBe(400);
      expect((await asMentee.post('/api/goals', { data: { relationId: p.rel.id, title: 'x', visibility: 'EVERYONE' } })).status()).toBe(400);

      // completedAt semantics are unchanged: set on DONE, cleared on reopen.
      expect((await asMentee.patch(`/api/goals/${privateGoal.id}`, { data: { status: 'DONE' } })).status()).toBe(200);
      expect((await prisma.goal.findUnique({ where: { id: privateGoal.id } }))?.completedAt).not.toBeNull();
      expect((await asMentee.patch(`/api/goals/${privateGoal.id}`, { data: { status: 'OPEN' } })).status()).toBe(200);
      expect((await prisma.goal.findUnique({ where: { id: privateGoal.id } }))?.completedAt).toBeNull();

      // The archived-relation lock (#1408) still fires for the mentee.
      await prisma.mentorshipRelation.update({ where: { id: p.rel.id }, data: { status: 'COMPLETED', completedAt: new Date() } });
      const locked = await asMentee.post('/api/goals', { data: { relationId: p.rel.id, title: 'too late', visibility: 'PRIVATE' } });
      expect(locked.status()).toBe(409);
      expect((await locked.json()).code).toBe('inactive_relation');
    } finally {
      await asMentee.dispose();
      await asMentor.dispose();
      await asAdmin.dispose();
      await p.cleanup();
    }
  }
);

test('the panel renders criteria, target date, progress and the scope badge, and the form writes them', async ({ page }) => {
  const p = await seedPair('goal-render');
  try {
    const seeded = await prisma.goal.create({
      data: {
        relationId: p.rel.id,
        title: 'Give a 10-minute talk',
        successCriteria: 'Talk delivered at the team meeting\nSlides shared afterwards',
        targetDate: new Date('2026-11-15T00:00:00Z'),
        progress: 40,
        visibility: 'PROGRAM',
        createdByRole: 'MENTOR',
        createdById: p.mentor.id,
      },
    });

    await signInAndSettle(page, p.mentorEmail, 'Pass1234!', '/mentor');
    await page.goto(`/mentor/mentees/${p.rel.id}`);
    const row = page.getByTestId(`goal-${seeded.id}`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.getByTestId('goal-success-criteria')).toContainText('Talk delivered at the team meeting');
    await expect(row.getByTestId('goal-target-date')).toContainText('Target date');
    await expect(row.getByTestId('goal-target-date')).toContainText('2026');
    const bar = row.getByTestId('goal-progress');
    await expect(bar).toHaveAttribute('role', 'progressbar');
    await expect(bar).toHaveAttribute('aria-valuenow', '40');
    await expect(row.getByTestId('goal-progress-value')).toContainText('40%');
    await expect(row.getByTestId('goal-visibility-badge')).toContainText('Programme');

    // The add form keeps its one-line shape; the depth sits behind a disclosure.
    await expect(page.getByTestId('new-goal-details')).toHaveCount(0);
    await page.getByRole('button', { name: 'More details' }).click();
    const details = page.getByTestId('new-goal-details');
    await expect(details).toBeVisible();
    await page.getByLabel('New goal').fill('Read one RFC a week');
    await details.getByLabel('Success criteria').fill('Four RFC summaries in the shared notes');
    await details.getByLabel('Target date').fill('2026-12-31');
    await details.getByLabel('Progress').fill('10');
    await details.getByLabel('Who can see it').selectOption('PRIVATE');
    await page.getByRole('button', { name: 'Add', exact: true }).click();

    const created = page.getByTestId('active-goals').getByText('Read one RFC a week');
    await expect(created).toBeVisible({ timeout: 10_000 });
    const stored = await prisma.goal.findFirst({ where: { relationId: p.rel.id, title: 'Read one RFC a week' } });
    expect(stored?.successCriteria).toBe('Four RFC summaries in the shared notes');
    expect(stored?.targetDate?.toISOString()).toContain('2026-12-31');
    expect(stored?.progress).toBe(10);
    expect(stored?.visibility).toBe('PRIVATE');
    expect(stored?.createdById).toBe(p.mentor.id);
    const newRow = page.getByTestId(`goal-${stored!.id}`);
    await expect(newRow.getByTestId('goal-visibility-badge')).toContainText('Private');
    await expect(newRow.getByTestId('goal-progress')).toHaveAttribute('aria-valuenow', '10');
  } finally {
    await p.cleanup();
  }
});
