import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, signInAsFreshUser, gotoSettled } from './helpers/auth';

/**
 * A mentee a mentor adds without an e-mail gets a generated `@import.local`
 * address and a sentinel password, so the record can never sign in and no reset
 * mail can reach it. #1123 gives that record a way out: the mentor sets the real
 * address on the *existing* row and the mentee gets an activation link.
 */

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('a mentor can turn a placeholder mentee into an account that signs in', async ({ page }) => {
  const mentorEmail = uniqueEmail('activate-mentor');
  const menteeEmail = uniqueEmail('activate-mentee');
  const mentorPw = 'MentorPass123!';
  const menteePw = 'MenteeChosen456!';
  const menteeName = `ZZ Activation Mentee ${Date.now()}`;
  const mentor = await seedUser(mentorEmail, mentorPw, 'MENTOR', 'Activation Mentor');
  let menteeId: string | null = null;

  try {
    await signInAndSettle(page, mentorEmail, mentorPw, '/mentor');

    // Create a mentee WITHOUT an e-mail — the tracking-only case.
    await gotoSettled(page, '/mentor/mentees/new');
    await page.getByLabel(/Full Name/).fill(menteeName);
    const created = page.waitForResponse(
      (r) => r.url().includes('/api/mentor/mentees') && r.request().method() === 'POST'
    );
    await page.getByRole('button', { name: 'Create' }).click();
    await created;

    const mentee = await prisma.user.findFirst({ where: { fullName: menteeName, role: 'MENTEE' } });
    expect(mentee).not.toBeNull();
    menteeId = mentee!.id;
    expect(mentee!.email).toContain('@import.local');

    const relation = await prisma.mentorshipRelation.findFirst({
      where: { mentorId: mentor.id, menteeId: mentee!.id },
    });
    expect(relation).not.toBeNull();

    // The detail page offers the way in.
    await gotoSettled(page, `/mentor/mentees/${relation!.id}`);
    const panel = page.getByTestId('mentee-activation-panel');
    await expect(panel).toBeVisible({ timeout: 15_000 });

    await page.getByTestId('mentee-activation-email').fill(menteeEmail);
    const patched = page.waitForResponse(
      (r) => r.url().includes(`/api/mentor/mentees/${mentee!.id}`) && r.request().method() === 'PATCH'
    );
    await page.getByTestId('mentee-activation-submit').click();
    expect((await patched).status()).toBe(200);

    // Same row, real address — the record and its history are not replaced.
    const updated = await prisma.user.findUnique({ where: { id: mentee!.id } });
    expect(updated!.email).toBe(menteeEmail);
    expect(await prisma.mentorshipRelation.count({ where: { menteeId: mentee!.id } })).toBe(1);

    // The activation link is shown so the mentor can pass it on if mail is down.
    const link = await page.getByTestId('mentee-activation-link').locator('input[readonly]').inputValue();
    expect(link).toContain('/auth/reset?token=');
    const token = new URL(link).searchParams.get('token')!;
    const tokenRow = await prisma.passwordResetToken.findUnique({ where: { token } });
    expect(tokenRow?.purpose).toBe('SET_INITIAL');
    expect(tokenRow?.userId).toBe(mentee!.id);

    // The mentee sets a password and signs in — the whole point of the fix.
    await page.goto(`/auth/reset?token=${token}`);
    await page.getByLabel(/New password/).fill(menteePw);
    await page.getByLabel(/Confirm Password/i).fill(menteePw);
    const done = page.waitForResponse(
      (r) => r.url().includes('/api/auth/reset') && r.request().method() === 'POST'
    );
    await page.getByRole('button', { name: /Update password/ }).click();
    await done;
    await page.waitForURL((u) => u.pathname.startsWith('/auth/signin'), { timeout: 20_000 });

    await signInAsFreshUser(page, menteeEmail, menteePw, '/portal');
  } finally {
    if (menteeId) {
      await prisma.mentorshipRelation.deleteMany({ where: { menteeId } });
      await prisma.user.delete({ where: { id: menteeId } }).catch(() => {});
    }
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});

test('activation is refused for accounts with a password, placeholder domains and foreign mentors', async ({
  page,
}) => {
  const mentorEmail = uniqueEmail('activate-guard-mentor');
  const otherMentorEmail = uniqueEmail('activate-guard-other');
  const activeMenteeEmail = uniqueEmail('activate-guard-mentee');
  const pw = 'MentorPass123!';
  const mentor = await seedUser(mentorEmail, pw, 'MENTOR', 'Guard Mentor');
  await seedUser(otherMentorEmail, pw, 'MENTOR', 'Guard Other Mentor');
  const activeMentee = await seedUser(activeMenteeEmail, 'MenteePass123!', 'MENTEE', 'Guard Active Mentee');
  const placeholder = await prisma.user.create({
    data: {
      email: `mentee.guard.${Date.now()}@import.local`,
      password: '!created-no-login',
      role: 'MENTEE',
      fullName: `ZZ Guard Placeholder ${Date.now()}`,
      skills: [],
    },
  });
  await prisma.mentorshipRelation.createMany({
    data: [
      { mentorId: mentor.id, menteeId: activeMentee.id },
      { mentorId: mentor.id, menteeId: placeholder.id },
    ],
  });

  try {
    await signInAndSettle(page, mentorEmail, pw, '/mentor');

    // Someone who already set a password owns their address — re-pointing it and
    // mailing yourself a set-password link would be account takeover.
    const hijack = await page.request.patch(`/api/mentor/mentees/${activeMentee.id}`, {
      data: { email: uniqueEmail('activate-hijack') },
    });
    expect(hijack.status()).toBe(409);
    expect((await prisma.user.findUnique({ where: { id: activeMentee.id } }))!.email).toBe(activeMenteeEmail);

    // The stand-in domain is not a mailbox — accepting it would recreate the bug.
    const fake = await page.request.patch(`/api/mentor/mentees/${placeholder.id}`, {
      data: { email: 'still.not.real@import.local' },
    });
    expect(fake.status()).toBe(400);

    // A mentor the record isn't assigned to cannot touch it.
    await signInAsFreshUser(page, otherMentorEmail, pw, '/mentor');
    const foreign = await page.request.patch(`/api/mentor/mentees/${placeholder.id}`, {
      data: { email: uniqueEmail('activate-foreign') },
    });
    expect(foreign.status()).toBe(403);
    expect((await prisma.user.findUnique({ where: { id: placeholder.id } }))!.email).toContain('@import.local');
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { menteeId: placeholder.id } });
    await prisma.user.delete({ where: { id: placeholder.id } }).catch(() => {});
    await cleanupByEmail(activeMenteeEmail);
    await cleanupByEmail(otherMentorEmail);
    await cleanupByEmail(mentorEmail);
  }
});
