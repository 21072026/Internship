import { test, expect, request as playwrightRequest } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInViaApi } from './helpers/auth';
import { sweepEndingSoonRelations } from '../src/lib/relationEndingSweep';
import { makeEmailActionToken } from '../src/lib/emailActionToken';

// The end of an agreed pairing (#1786), the sweep run in-process against the
// test DB: one ending-soon notice + mail per participant per end date, nothing
// on a second run, nothing for a paused pair; a mentee cannot extend; the
// mentor extends (date moved, counter up, stamp cleared, audit row); the mail's
// signed link extends once and its replay is refused; a new end date inside
// the window nudges again.

test.afterAll(async () => prisma.$disconnect());

const PW = 'EndingPass123!';
const DAY = 24 * 60 * 60 * 1000;
const day = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null;
const utcDay = (offsetDays: number) => {
  const d = new Date(Date.now() + offsetDays * DAY);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};

test('ending soon: one nudge per end date, extend from the app and from the mail, re-nudge for the new date', async ({ page, request, baseURL }) => {
  test.setTimeout(120_000);
  const emails = ['end-mentor', 'end-mentee', 'end-mentee2'].map((p) => uniqueEmail(p));
  const [mentorEmail, menteeEmail, mentee2Email] = emails;
  try {
    const mentor = await seedUser(mentorEmail, PW, 'MENTOR', 'Ending Mentor');
    const mentee = await seedUser(menteeEmail, PW, 'MENTEE', 'Ending Mentee');
    const mentee2 = await seedUser(mentee2Email, PW, 'MENTEE', 'Paused Mentee');
    const startDate = new Date(Date.now() - 180 * DAY);
    const rel = await prisma.mentorshipRelation.create({
      data: { mentorId: mentor.id, menteeId: mentee.id, startDate, expectedEndDate: utcDay(10) },
    });
    const paused = await prisma.mentorshipRelation.create({
      data: { mentorId: mentor.id, menteeId: mentee2.id, startDate, expectedEndDate: utcDay(5), lifecycleState: 'PAUSED', pausedAt: new Date() },
    });
    const notices = () => prisma.notification.count({ where: { userId: { in: [mentor.id, mentee.id, mentee2.id] }, type: 'mentorship.ending_soon' } });
    const mails = () => prisma.emailLog.count({ where: { to: { in: [mentorEmail, menteeEmail, mentee2Email] }, category: 'relation-ending' } });

    await sweepEndingSoonRelations();
    const stamped = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: rel.id } });
    expect(stamped.endingSoonNotifiedAt).not.toBeNull();
    expect(await notices()).toBe(2);
    await expect.poll(mails, { timeout: 15_000 }).toBe(2);
    // A paused pair is not nudged.
    expect((await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: paused.id } })).endingSoonNotifiedAt).toBeNull();

    // Running the sweep twice sends nothing the second time.
    await sweepEndingSoonRelations();
    expect(await notices()).toBe(2);
    expect(await mails()).toBe(2);

    // A mentee cannot extend their own pairing.
    const menteeCtx = await playwrightRequest.newContext({ baseURL });
    try {
      expect((await signInViaApi(menteeCtx, menteeEmail, PW)).ok).toBe(true);
      expect((await menteeCtx.post(`/api/mentorship/${rel.id}/extend`, { data: {} })).status()).toBe(403);
    } finally {
      await menteeCtx.dispose();
    }

    // The mentor extends by the original length (six months).
    expect((await signInViaApi(request, mentorEmail, PW)).ok).toBe(true);
    const before = day(stamped.expectedEndDate)!;
    const ext = await request.post(`/api/mentorship/${rel.id}/extend`, { data: { note: 'One more semester' } });
    expect(ext.ok()).toBeTruthy();
    const extended = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: rel.id } });
    expect(extended.durationExtendedCount).toBe(1);
    expect(extended.endingSoonNotifiedAt).toBeNull();
    expect(extended.expectedEndDate!.getTime()).toBeGreaterThan(stamped.expectedEndDate!.getTime() + 150 * DAY);
    const audit = await prisma.relationLifecycleEvent.findFirst({ where: { relationId: rel.id, reasonCode: 'extended' } });
    expect(audit).toMatchObject({ fromState: 'ACTIVE', toState: 'ACTIVE', changedById: mentor.id });
    expect(await prisma.notification.count({ where: { userId: mentee.id, type: 'mentorship.extended' } })).toBe(1);

    // The new date is far out: nothing to nudge.
    await sweepEndingSoonRelations();
    expect(await notices()).toBe(2);

    // The link from the FIRST mail was minted for the old end date: it is spent.
    const oldLink = makeEmailActionToken({ kind: 'extend', relationId: rel.id, userId: mentor.id, fromDay: before.replace(/-/g, '') });
    const stale = await request.post('/api/email-action', { data: { token: oldLink } });
    expect(stale.status()).toBe(409);
    expect((await stale.json()).code).toBe('stale');

    // A month later the date is moved into the window again (an admin edit
    // stands in for the passage of time): it gets its own single nudge.
    await prisma.mentorshipRelation.update({ where: { id: rel.id }, data: { expectedEndDate: utcDay(7), endingSoonNotifiedAt: null } });
    await sweepEndingSoonRelations();
    expect(await notices()).toBe(4);
    await expect.poll(mails, { timeout: 15_000 }).toBe(4);

    // The mentor extends from that mail, without a session: the page performs
    // it, and the very same link cannot extend a second time.
    const link = makeEmailActionToken({ kind: 'extend', relationId: rel.id, userId: mentor.id, fromDay: day(utcDay(7))!.replace(/-/g, '') });
    await page.goto(`/m/${encodeURIComponent(link)}`);
    await expect(page.getByTestId('email-action-extended')).toBeVisible();
    const fromMail = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: rel.id } });
    expect(fromMail.durationExtendedCount).toBe(2);
    expect(fromMail.endingSoonNotifiedAt).toBeNull();
    const replay = await playwrightRequest.newContext({ baseURL });
    try {
      const again = await replay.post('/api/email-action', { data: { token: link } });
      expect(again.status()).toBe(409);
    } finally {
      await replay.dispose();
    }
    expect((await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: rel.id } })).durationExtendedCount).toBe(2);
  } finally {
    for (const e of emails) await cleanupByEmail(e);
  }
});
