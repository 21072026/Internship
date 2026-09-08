import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

/**
 * Admin-initiated mentor change (#2289), end to end.
 *
 * What is being pinned is not "a button exists" but the two states the
 * operation may leave behind, because the thing it replaces — mark COMPLETED,
 * then assign somebody else — leaves a record claiming a mentorship finished
 * successfully when it did not:
 *
 *   a pairing with no history  → the mentor is CORRECTED in place, no second row
 *   a pairing with history     → closed ENDED_REASSIGNED, successor chained to it
 *
 * and in both cases: EXACTLY ONE live relation for the mentee, never two and
 * never none.
 */
test('a mis-assignment is corrected in place — no closed relation left behind', async ({ page }) => {
  const pw = 'TransferPass123';
  const adminEmail = uniqueEmail('mt-admin');
  const menteeEmail = uniqueEmail('mt-mentee');
  const rightMentorEmail = uniqueEmail('mt-right');

  const admin = await seedUser(adminEmail, pw, 'ADMIN', 'Transfer Admin');
  const mentee = await seedUser(menteeEmail, pw, 'MENTEE', 'Transfer Mentee');
  const rightMentor = await seedUser(rightMentorEmail, 'x', 'MENTOR', 'Transfer Right Mentor');

  // The maintainer's own case: the admin assigned the mentee to THEMSELF by
  // accident and now wants the real mentor on it.
  const relation = await prisma.mentorshipRelation.create({
    data: { mentorId: admin.id, menteeId: mentee.id },
  });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', pw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    // A reason is required, and "other" needs the note — the two refusals the
    // dialog mirrors client-side, asserted on the server where they are the rule.
    const noReason = await page.request.post(`/api/mentorship/${relation.id}/transfer`, {
      data: { toMentorId: rightMentor.id, reasonCode: 'not_a_real_code' },
    });
    expect(noReason.status()).toBe(400);
    expect((await noReason.json()).code).toBe('invalid_reason');

    const noNote = await page.request.post(`/api/mentorship/${relation.id}/transfer`, {
      data: { toMentorId: rightMentor.id, reasonCode: 'other' },
    });
    expect(noNote.status()).toBe(400);
    expect((await noNote.json()).code).toBe('note_required');

    // Re-picking the mentor they already have is not a change.
    const same = await page.request.post(`/api/mentorship/${relation.id}/transfer`, {
      data: { toMentorId: admin.id, reasonCode: 'wrong_assignment' },
    });
    expect(same.status()).toBe(400);
    expect((await same.json()).code).toBe('same_mentor');

    // Now the real thing, through the admin UI.
    await page.goto('/admin/mentorship');
    await page.getByTestId(`change-mentor-${relation.id}`).click();
    await expect(page.getByTestId('change-mentor-dialog')).toBeVisible();
    await page.getByTestId('change-mentor-select').selectOption(rightMentor.id);
    await page.getByTestId('change-mentor-reason').selectOption('wrong_assignment');
    await page.getByTestId('change-mentor-submit').click();
    await expect(page.getByTestId('mentorship-notice')).toBeVisible({ timeout: 15_000 });

    // The pairing had nothing recorded under it, so it was corrected in place:
    // one row, the right mentor, still ACTIVE and never marked completed.
    const rows = await prisma.mentorshipRelation.findMany({ where: { menteeId: mentee.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(relation.id);
    expect(rows[0].mentorId).toBe(rightMentor.id);
    expect(rows[0].status).toBe('ACTIVE');
    expect(rows[0].completedAt).toBeNull();
    expect(rows[0].lifecycleState).toBeNull();
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { menteeId: mentee.id } });
    await cleanupByEmail(adminEmail);
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(rightMentorEmail);
  }
});

test('a pairing with history is handed over: closed ENDED_REASSIGNED, successor keeps the stage', async ({ page }) => {
  const pw = 'TransferPass123';
  const adminEmail = uniqueEmail('mt2-admin');
  const menteeEmail = uniqueEmail('mt2-mentee');
  const oldMentorEmail = uniqueEmail('mt2-old');
  const newMentorEmail = uniqueEmail('mt2-new');

  await seedUser(adminEmail, pw, 'ADMIN', 'Handover Admin');
  const mentee = await seedUser(menteeEmail, pw, 'MENTEE', 'Handover Mentee');
  const oldMentor = await seedUser(oldMentorEmail, 'x', 'MENTOR', 'Handover Old Mentor');
  const newMentor = await seedUser(newMentorEmail, 'x', 'MENTOR', 'Handover New Mentor');

  const relation = await prisma.mentorshipRelation.create({
    data: { mentorId: oldMentor.id, menteeId: mentee.id, pipelineStatus: 'INTERNSHIP_IN_PROGRESS_450' },
  });
  // One logged interaction is enough to make this a real mentorship: it is the
  // outgoing mentor's work, and it must not be re-attributed to the new one.
  await prisma.interactionLog.create({
    data: { relationId: relation.id, date: new Date(), notes: 'Kick-off call', type: 'Meeting' },
  });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', pw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    const res = await page.request.post(`/api/mentorship/${relation.id}/transfer`, {
      data: { toMentorId: newMentor.id, reasonCode: 'mentor_unavailable' },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.mode).toBe('transferred');

    // The old pairing is closed as a mentor change — never as a completion —
    // and keeps every row that was written under it.
    const old = await prisma.mentorshipRelation.findUnique({
      where: { id: relation.id },
      include: { _count: { select: { interactions: true } } },
    });
    expect(old!.status).toBe('COMPLETED');
    expect(old!.lifecycleState).toBe('ENDED_REASSIGNED');
    expect(old!.endReasonCode).toBe('mentor_unavailable');
    expect(old!._count.interactions).toBe(1);
    expect(old!.mentorId).toBe(oldMentor.id);

    // Exactly one live relation, with the new mentor, on the SAME stage — a
    // hired-track candidate must not fall back to the first column because
    // their mentor changed — and it points back at its predecessor.
    const live = await prisma.mentorshipRelation.findMany({ where: { menteeId: mentee.id, status: 'ACTIVE' } });
    expect(live).toHaveLength(1);
    expect(live[0].mentorId).toBe(newMentor.id);
    expect(live[0].pipelineStatus).toBe('INTERNSHIP_IN_PROGRESS_450');
    expect(live[0].previousRelationId).toBe(relation.id);

    // The three people are told three different true things, and the outgoing
    // mentor is not told the reason (#1801's rule, kept here).
    const menteeNotices = await prisma.notification.findMany({
      where: { userId: mentee.id, type: 'mentorship.mentorChanged' },
    });
    expect(menteeNotices.length).toBeGreaterThanOrEqual(1);
    const outgoing = await prisma.notification.findMany({
      where: { userId: oldMentor.id, type: 'mentorship.reassignedAway' },
    });
    expect(outgoing.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(outgoing[0].params)).not.toContain('mentor_unavailable');

    // A closed pairing cannot be handed over a second time.
    const again = await page.request.post(`/api/mentorship/${relation.id}/transfer`, {
      data: { toMentorId: oldMentor.id, reasonCode: 'no_fit' },
    });
    expect(again.status()).toBe(409);
    expect((await again.json()).code).toBe('inactive_relation');

    // The list tells the truth about the closed row rather than calling it
    // "Completed" like any finished mentorship. Asserted on the testid, not on
    // the label: the badge's text is translated and the suite's locale is not
    // this test's business.
    await page.goto('/admin/mentorship');
    await expect(
      page.getByTestId(`mentorship-row-${relation.id}`).getByTestId('lifecycle-badge')
    ).toBeVisible({ timeout: 15_000 });
  } finally {
    await prisma.interactionLog.deleteMany({ where: { relation: { menteeId: mentee.id } } });
    // The successor references the predecessor, so it goes first.
    await prisma.mentorshipRelation.deleteMany({ where: { menteeId: mentee.id, previousRelationId: { not: null } } });
    await prisma.mentorshipRelation.deleteMany({ where: { menteeId: mentee.id } });
    await cleanupByEmail(adminEmail);
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(oldMentorEmail);
    await cleanupByEmail(newMentorEmail);
  }
});

/**
 * The refusal that used to be a dead end: assigning a second mentor answers 409,
 * and now the body names who is in the way so the dialog can offer the change.
 */
test('the already_mentored refusal names the current mentor', async ({ page }) => {
  const pw = 'TransferPass123';
  const adminEmail = uniqueEmail('mt3-admin');
  const menteeEmail = uniqueEmail('mt3-mentee');
  const mentorEmail = uniqueEmail('mt3-mentor');
  const otherEmail = uniqueEmail('mt3-other');

  await seedUser(adminEmail, pw, 'ADMIN', 'Refusal Admin');
  const mentee = await seedUser(menteeEmail, pw, 'MENTEE', 'Refusal Mentee');
  const mentor = await seedUser(mentorEmail, 'x', 'MENTOR', 'Refusal Current Mentor');
  const other = await seedUser(otherEmail, 'x', 'MENTOR', 'Refusal Other Mentor');

  const relation = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id },
  });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', pw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    const res = await page.request.post('/api/mentorship', {
      data: { mentorId: other.id, menteeId: mentee.id },
    });
    expect(res.status()).toBe(409);
    const body = await res.json();
    // The sentence and the code are untouched (other callers and
    // e2e/dup-guard-transliteration.spec.ts match on them); the two new fields
    // are what make the wall a door.
    expect(body.code).toBe('already_mentored');
    expect(body.error).toMatch(/active mentorship/i);
    expect(body.activeRelationId).toBe(relation.id);
    expect(body.activeMentorName).toBe('Refusal Current Mentor');
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { menteeId: mentee.id } });
    await cleanupByEmail(adminEmail);
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(otherEmail);
  }
});
