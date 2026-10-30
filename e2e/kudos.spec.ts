import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, signInViaApi, gotoSettled } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #1868: a kudo is a written, named thank-you inside a pairing. The mentor
// sends one from the mentee detail page, the mentee reads it on the portal and
// on their account page, the mentee thanks back; a stranger is 403, a reader
// outside the pair is 403, and no numeric field exists to game.
test('kudos: mentor thanks mentee, mentee reads and thanks back; strangers refused', async ({ page, playwright }, info) => {
  const mentorEmail = uniqueEmail('kd-mentor');
  const menteeEmail = uniqueEmail('kd-mentee');
  const otherEmail = uniqueEmail('kd-other');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'KD Mentor');
  const mentee = await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'KD Mentee');
  await seedUser(otherEmail, 'MentorPass123', 'MENTOR', 'KD Other');
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });
  const other = await playwright.request.newContext({ baseURL: info.project.use.baseURL });

  try {
    await signInAndSettle(page, mentorEmail, 'MentorPass123', '/mentor');
    await gotoSettled(page, `/mentor/mentees/${rel.id}`);
    const panel = page.getByTestId('kudos-panel');
    await expect(panel.getByTestId('kudos-empty')).toBeVisible({ timeout: 30_000 });
    await panel.getByTestId('kudo-preset-wellPrepared').click();
    await expect(panel.getByTestId('kudo-reason')).toHaveValue(/prepared/);
    await panel.getByTestId('kudo-reason').fill('Thank you for the excellent demo prep.');
    await panel.getByTestId('kudo-send').click();
    await expect(panel.getByTestId('kudos-list').getByText('Thank you for the excellent demo prep.')).toBeVisible({ timeout: 30_000 });

    const saved = await prisma.kudo.findFirstOrThrow({ where: { relationId: rel.id } });
    expect(saved.senderId).toBe(mentor.id);
    expect(saved.recipientId).toBe(mentee.id);
    expect(saved.presetKey).toBe('wellPrepared');
    // No gamification column exists on the row.
    for (const key of ['points', 'score', 'level', 'tier', 'streak', 'badge']) expect(saved).not.toHaveProperty(key);
    // The recipient was told.
    await expect.poll(() => prisma.notification.count({ where: { userId: mentee.id, type: 'kudo.received' } })).toBe(1);

    // The mentee sees it on the portal and thanks back.
    await page.context().clearCookies();
    await signInAndSettle(page, menteeEmail, 'MenteePass123', '/portal');
    await gotoSettled(page, '/portal/goals');
    const menteePanel = page.getByTestId('kudos-panel');
    await expect(menteePanel.getByText('Thank you for the excellent demo prep.')).toBeVisible({ timeout: 30_000 });
    await menteePanel.getByTestId('kudo-reason').fill('Thanks for the patience.');
    await menteePanel.getByTestId('kudo-send').click();
    await expect(menteePanel.getByText('Thanks for the patience.')).toBeVisible({ timeout: 30_000 });
    expect(await prisma.kudo.count({ where: { relationId: rel.id, senderId: mentee.id, recipientId: mentor.id } })).toBe(1);

    // …and on their own account page, received only.
    await gotoSettled(page, '/account');
    const received = page.getByTestId('kudos-received');
    await expect(received.getByText('Thank you for the excellent demo prep.')).toBeVisible({ timeout: 30_000 });
    await expect(received.getByText('Thanks for the patience.')).toHaveCount(0);

    // API: no self-thanks; a stranger may neither send nor read.
    expect((await page.request.post('/api/kudos', { data: { relationId: rel.id, recipientId: mentee.id, reason: 'me' } })).status()).toBe(403);
    expect((await signInViaApi(other, otherEmail, 'MentorPass123')).ok).toBe(true);
    expect((await other.post('/api/kudos', { data: { relationId: rel.id, recipientId: mentee.id, reason: 'hi' } })).status()).toBe(403);
    expect((await other.get(`/api/kudos?relationId=${rel.id}`)).status()).toBe(403);
    expect(await prisma.kudo.count({ where: { relationId: rel.id } })).toBe(2);
  } finally {
    await other.dispose();
    await prisma.kudo.deleteMany({ where: { relationId: rel.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    for (const e of [mentorEmail, menteeEmail, otherEmail]) await cleanupByEmail(e);
  }
});
