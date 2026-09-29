import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAsFreshUser, gotoSettled } from './helpers/auth';

// "Next action + follow-up date" on a record (#2563). The acceptance criteria:
// a record whose date is today reminds its owner once, from the next day it is
// in the attention queue as `next_action_due`, moving the date takes it out —
// and a stage change never clears the date (it is not the stage SLA).
//
// "The next day" is reached by writing yesterday's date, not by moving a clock:
// the rule is by UTC calendar day (lib/nextActionRule.ts, unit-tested with a
// fixed clock), so a date one day back IS the next-day state.

test.afterAll(async () => {
  await prisma.$disconnect();
});

const utcDay = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

test('a follow-up date reminds its owner once, then flags the record until it is moved', async ({ page }) => {
  // Four sign-ins across three roles (owner, admin for the job, the mentee for
  // the privacy check), each landing on its own dashboard.
  test.slow();
  const adminEmail = uniqueEmail('fu-admin');
  const mentorEmail = uniqueEmail('fu-mentor');
  const menteeEmail = uniqueEmail('fu-mentee');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'FU Admin');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'FU Mentor');
  const mentee = await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'Follow Up Mentee');
  // Two accounts under one search tag: the dated one (this record's) and one
  // with no follow-up — `sort=followup` must put the dated one first although
  // the name order puts it second.
  const tag = `fu${Date.now()}`;
  const undated = await prisma.company.create({ data: { name: `A ${tag}` } });
  const dated = await prisma.company.create({ data: { name: `B ${tag}` } });
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id, companyId: dated.id } });

  try {
    // The owner writes today's follow-up on the record detail.
    await signInAsFreshUser(page, mentorEmail, 'MentorPass123', '/mentor');
    await gotoSettled(page, `/mentor/mentees/${rel.id}`);
    const panel = page.getByTestId('follow-up-panel');
    await panel.getByTestId('follow-up-date').fill(utcDay(0));
    await panel.getByTestId('follow-up-note').fill('Call about pricing');
    await panel.getByTestId('follow-up-save').click();
    // The chip reads the refetched record, not the input — a slow refetch is
    // still the thing under test, so wait for it rather than for the toast.
    await expect(panel.getByTestId('follow-up-status')).toHaveText('Due today', { timeout: 60_000 });

    const saved = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: rel.id } });
    expect(saved.nextActionAt?.toISOString()).toBe(`${utcDay(0)}T00:00:00.000Z`);
    expect(saved.nextActionNote).toBe('Call about pricing');

    // A stage change leaves it alone — independent of the stage SLA.
    const move = await page.request.put(`/api/mentorship/${rel.id}`, { data: { pipelineStatus: 'APPROVAL_PENDING_220' } });
    expect(move.ok()).toBeTruthy();
    const moved = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: rel.id } });
    expect(moved.pipelineStatus).toBe('APPROVAL_PENDING_220');
    expect(moved.nextActionAt?.toISOString()).toBe(saved.nextActionAt?.toISOString());
    expect(moved.nextActionNote).toBe('Call about pricing');

    // Today on the due day: not in the queue yet — the day is the reminder's.
    await gotoSettled(page, '/mentor');
    const row = () => page.getByTestId('attention-queue').getByRole('link', { name: /Follow Up Mentee/ });
    await expect(row()).toBeVisible({ timeout: 10_000 });
    await expect(row().getByText('Follow-up overdue')).toHaveCount(0);

    // The daily job reminds the owner — once.
    await signInAsFreshUser(page, adminEmail, 'AdminPass123', '/admin');
    const first = await (await page.request.get('/api/cron?job=stage-deadlines')).json();
    expect(first.deadlines.nextActions.reminded).toBeGreaterThanOrEqual(1);
    await page.request.get('/api/cron?job=stage-deadlines');
    const notes = await prisma.notification.findMany({ where: { userId: mentor.id, type: 'deadline.nextActionDue' } });
    expect(notes).toHaveLength(1);
    expect(notes[0].link).toBe(`/mentor/mentees/${rel.id}`);

    // The account list ranks by the soonest follow-up; undated accounts last.
    const ids = async (sort: string) =>
      ((await (await page.request.get(`/api/companies?all=1&search=${tag}&sort=${sort}`, { timeout: 60_000 })).json()).companies as { id: string }[]).map((c) => c.id);
    expect(await ids('name')).toEqual([undated.id, dated.id]);
    expect(await ids('followup')).toEqual([dated.id, undated.id]);

    // The mentee reads this relation too, and never gets the owner's note.
    await signInAsFreshUser(page, menteeEmail, 'MenteePass123', '/portal');
    const asMentee = await (await page.request.get(`/api/mentorship/${rel.id}`)).json();
    expect(asMentee.relation.id).toBe(rel.id);
    expect(asMentee.relation).not.toHaveProperty('nextActionNote');
    expect(asMentee.relation).not.toHaveProperty('nextActionAt');

    // The next day: the date has passed → the record is flagged.
    await signInAsFreshUser(page, mentorEmail, 'MentorPass123', '/mentor');
    const back = await page.request.put(`/api/mentorship/${rel.id}`, { data: { nextActionAt: utcDay(-1) } });
    expect(back.ok()).toBeTruthy();
    await gotoSettled(page, '/mentor');
    await expect(row().getByText('Follow-up overdue')).toBeVisible({ timeout: 10_000 });

    // Moving the date forward takes it out again.
    await gotoSettled(page, `/mentor/mentees/${rel.id}`);
    await panel.getByTestId('follow-up-date').fill(utcDay(1));
    await panel.getByTestId('follow-up-save').click();
    await expect(page.getByText('Follow-up saved')).toBeVisible();
    await gotoSettled(page, '/mentor');
    await expect(row()).toBeVisible({ timeout: 10_000 });
    await expect(row().getByText('Follow-up overdue')).toHaveCount(0);
    const moved2 = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: rel.id } });
    expect(moved2.nextActionRemindedAt).toBeNull();
  } finally {
    await prisma.notification.deleteMany({ where: { userId: mentor.id } });
    await prisma.statusChange.deleteMany({ where: { relationId: rel.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await prisma.company.deleteMany({ where: { id: { in: [undated.id, dated.id] } } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  }
});
