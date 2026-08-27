import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';
import { sendEmail } from '@/services/emailService';
import { prisma as appPrisma } from '@/lib/prisma';
import { EMAIL_GROUP_IDS, emailGroupPrefKey } from '@/lib/emailGroups';
import { NOTIFICATION_CATEGORIES } from '@/lib/notificationPrefs';

/**
 * The one block in sendEmail() that makes an unsubscribe mean anything (#1456).
 *
 * There are 41 send sites in this app. Nine of them have no per-user preference
 * check of their own, and the three meeting-invite sites, /api/company-inquiry
 * and the mentor-application approval rely on the CENTRAL check in sendEmail()
 * and on nothing else. Its own comment calls it "the guarantee that cannot be
 * forgotten… the per-call-site checks are an optimisation" — and until this
 * spec, nothing asserted it. Deleting the block left the whole suite green, and
 * the only symptom in production would have been a spam complaint. It had
 * already come close: the merge that landed the feature had to repair this exact
 * path by hand (it was returning a bare `undefined` instead of 'SKIPPED') rather
 * than by watching a test go red.
 *
 * Shape borrowed from e2e/email-sent-honesty.spec.ts: drive a real route, then
 * read the EmailLog row the same request wrote. `SMTP_USER` is blank in this
 * environment (playwright.config.ts), so nothing is delivered and the row is the
 * only witness — which is exactly what makes it a usable one: an attempted send
 * lands as SKIPPED "SMTP not configured", a suppressed one as SKIPPED
 * "Unsubscribed: <group>". The two are distinguishable, so "did we decline to
 * mail this person, and for the right reason?" has an answer.
 *
 * Tagged @smoke deliberately. The PR gate runs only the smoke subset, and a
 * change that drops or reorders the central check is precisely the kind that
 * arrives in a merge and passes everything else.
 */

const PW = 'CentralEnforce123!';

async function latestLogFor(to: string) {
  return prisma.emailLog.findFirst({
    where: { to },
    orderBy: { createdAt: 'desc' },
    select: { status: true, error: true, category: true },
  });
}

/** Every switch this person could conceivably have turned off, turned off. */
const EVERYTHING_OFF = Object.fromEntries([
  ...EMAIL_GROUP_IDS.map((g) => [emailGroupPrefKey(g), false]),
  // The eleven legacy in-app keys too, since each one suppresses the groups that
  // list it in `legacy` — so this really is "no mail of any kind, please".
  ...NOTIFICATION_CATEGORIES.map((k) => [k, false]),
]);

/**
 * The two tests below call sendEmail() in THIS process, which is not the app
 * server and so does not inherit the blank `SMTP_USER` playwright.config.ts sets
 * for it. Blank it here as well: a developer with real SMTP credentials in their
 * environment must not have a test mail a stranger. Restores the previous value
 * exactly, deleting the key when there was none — assigning `undefined` to a
 * `process.env` entry stores the string "undefined".
 */
function blankSmtpUser(): () => void {
  const saved = process.env.SMTP_USER;
  process.env.SMTP_USER = '';
  return () => {
    if (saved === undefined) delete process.env.SMTP_USER;
    else process.env.SMTP_USER = saved;
  };
}

// No `describe.configure({ mode: 'serial' })`, unlike email-sent-honesty.spec:
// each test seeds and tears down its own users, and in serial mode the first
// failure marks the rest "did not run" — which for these three would hide the
// two halves of the answer (was it suppressed? was it suppressed for the right
// reason?) behind whichever one broke first.
test.afterAll(async () => {
  await prisma.$disconnect();
  await appPrisma.$disconnect();
});

test(
  'a mentee who switched off meeting invites is not mailed one, and the log says why',
  { tag: '@smoke' },
  async ({ page }) => {
    const mentorEmail = uniqueEmail('central-mentor');
    const optedOutEmail = uniqueEmail('central-optedout');
    const subscribedEmail = uniqueEmail('central-subscribed');
    const mentor = await seedUser(mentorEmail, PW, 'MENTOR', 'Central Mentor');
    const optedOut = await seedUser(optedOutEmail, PW, 'MENTEE', 'Central Opted Out');
    const subscribed = await seedUser(subscribedEmail, PW, 'MENTEE', 'Central Subscribed');
    // One switch, the one that names this mail. Nothing else is touched: the
    // master `emailNotifications` flag stays on, so a regression that only reads
    // the coarse switch cannot pass this test.
    await prisma.user.update({
      where: { id: optedOut.id },
      data: { notificationPrefs: { [emailGroupPrefKey('meeting_invites')]: false } },
    });
    const relations = await Promise.all(
      [optedOut, subscribed].map((mentee) =>
        prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } })
      )
    );
    const relationIds = relations.map((r) => r.id);

    try {
      await signInAndSettle(page, mentorEmail, PW, '/mentor');

      // Both mentees in ONE request, on purpose: the same code path, the same
      // transaction of work, the same environment — so the only difference
      // between the two outcomes below is the preference.
      const res = await page.request.post('/api/meetings', {
        data: {
          relationIds,
          title: 'Central enforcement check',
          scheduledAt: '2026-09-01T10:00:00.000Z',
          meetLink: '',
        },
      });
      expect(res.ok()).toBeTruthy();
      expect((await res.json()).created).toBe(2);

      // /api/meetings has no per-call-site preference check and never had one —
      // it passes the invitee's id and relies entirely on the block under test.
      const suppressed = await latestLogFor(optedOutEmail);
      expect(suppressed, `no EmailLog row was written for ${optedOutEmail}`).not.toBeNull();
      expect(suppressed!.status).toBe('SKIPPED');
      expect(suppressed!.error).toBe('Unsubscribed: meeting_invites');
      // The row names the group, not the category: "why did this not arrive?"
      // is answerable from the delivery log alone, which is what makes the skip
      // auditable rather than merely silent.
      expect(suppressed!.category).toBe('meeting-invite');

      // The control, and the teeth of this test: a mentee who opted out of
      // nothing IS mailed, so the assertion above cannot be satisfied by a
      // sendEmail that has simply stopped sending — or by a route that stopped
      // mailing anyone.
      const attempted = await latestLogFor(subscribedEmail);
      expect(attempted, `no EmailLog row was written for ${subscribedEmail}`).not.toBeNull();
      expect(attempted!.status).toBe('SKIPPED');
      expect(attempted!.error).toContain('SMTP not configured');

      // And the suppression is of the MAIL, not of the meeting: both mentees are
      // still invited to the room, still get their RSVP token and their in-app
      // notification. An unsubscribe is not a withdrawal from the product.
      expect(await prisma.meeting.count({ where: { relationId: { in: relationIds } } })).toBe(2);
      expect(await prisma.notification.count({ where: { userId: optedOut.id, type: 'meeting.scheduled' } })).toBe(1);
    } finally {
      await prisma.emailLog.deleteMany({ where: { to: { in: [optedOutEmail, subscribedEmail] } } });
      await prisma.meeting.deleteMany({ where: { relationId: { in: relationIds } } });
      await prisma.notification.deleteMany({ where: { userId: { in: [optedOut.id, subscribed.id] } } });
      await cleanupByEmail(optedOutEmail);
      await cleanupByEmail(subscribedEmail);
      await cleanupByEmail(mentorEmail);
    }
  }
);

/**
 * The mirror image, and the reason essential groups exist: a password reset must
 * go out even to somebody who has switched off literally everything. Somebody
 * "simplifying" the `isEssentialGroup` exemption out of `unsubscribable()` turns
 * every opted-out account into an account nobody can ever sign back in to —
 * silently, because the mail still returns normally.
 *
 * Called directly rather than through a route, and that is a deliberate choice
 * with a reason worth writing down: NO send site in this app passes both a
 * `userId` and an essential category today (the reset, verification and
 * invitation senders take no `userId` at all), so there is no HTTP request that
 * can reach the essential branch of the central check. A route-driven version of
 * this test would pass just as happily with the exemption deleted, which makes
 * it worse than no test. This is the same module the server runs and the same
 * database; only the transport in front of it is missing, and the meeting-invite
 * test above covers that half.
 */
test('an essential mail is attempted even for someone who switched off everything', async () => {
  const email = uniqueEmail('central-essential');
  const user = await seedUser(email, PW, 'MENTEE', 'Central Essential');
  await prisma.user.update({
    where: { id: user.id },
    data: { emailNotifications: false, notificationPrefs: EVERYTHING_OFF },
  });
  const restoreSmtp = blankSmtpUser();

  try {
    const essential = await sendEmail({
      to: email,
      subject: 'Reset your password',
      html: '<p>Reset link</p>',
      category: 'password-reset',
      userId: user.id,
    });
    expect(essential).toBe('SKIPPED');
    const attempted = await latestLogFor(email);
    // "Attempted" is the whole assertion: the environment stopped it, not the
    // preference. Both are SKIPPED rows — the `error` is what tells them apart.
    expect(attempted!.error).not.toContain('Unsubscribed');
    expect(attempted!.error).toContain('SMTP not configured');

    // Same user, same call, same switches — one non-essential category later,
    // the answer flips. Without this pair the test above would also pass in a
    // build where the central check never suppressed anything at all.
    const optional = await sendEmail({
      to: email,
      subject: 'Announcement',
      html: '<p>News</p>',
      category: 'announcement',
      userId: user.id,
    });
    expect(optional).toBe('SKIPPED');
    expect((await latestLogFor(email))!.error).toBe('Unsubscribed: announcements');
  } finally {
    restoreSmtp();
    await prisma.emailLog.deleteMany({ where: { to: email } });
    await cleanupByEmail(email);
  }
});

/**
 * The pre-resolved `prefs` argument (the announcement broadcast's economy: it
 * already selected these two columns for every recipient, and re-reading them
 * once per mail doubled the query count on the largest send the product makes).
 *
 * What has to stay true is that it is DATA and not a bypass: supplying it feeds
 * the same check, and omitting it costs a query rather than skipping anything.
 * Both directions are asserted, because a `prefs` that could be read as "already
 * checked, don't check again" would be a hole straight through the guarantee the
 * two tests above exist to protect.
 */
test('a pre-resolved preference row is checked, not trusted as an all-clear', async () => {
  const email = uniqueEmail('central-prefs');
  // Stored row: no preferences at all, i.e. this person is opted IN to
  // everything. Every suppression below therefore comes from the argument.
  const user = await seedUser(email, PW, 'MENTEE', 'Central Prefs');
  const restoreSmtp = blankSmtpUser();

  const announce = (prefs?: { emailNotifications?: boolean | null; notificationPrefs?: unknown }) =>
    sendEmail({
      to: email,
      subject: 'Announcement',
      html: '<p>News</p>',
      category: 'announcement',
      userId: user.id,
      ...(prefs ? { prefs } : {}),
    });

  try {
    // Nothing supplied: the row is read, and it allows the mail.
    expect(await announce()).toBe('SKIPPED');
    expect((await latestLogFor(email))!.error).toContain('SMTP not configured');

    // Supplied and opted out: suppressed. The check ran on what was handed in —
    // which is what "data, not a flag" means, and is why there is no way to
    // spell "don't check".
    expect(await announce({ notificationPrefs: { [emailGroupPrefKey('announcements')]: false } })).toBe('SKIPPED');
    expect((await latestLogFor(email))!.error).toBe('Unsubscribed: announcements');

    // Supplied and allowing: the same answer as reading the row, so the
    // broadcast's saved query cannot change anybody's outcome.
    expect(await announce({ emailNotifications: true, notificationPrefs: {} })).toBe('SKIPPED');
    expect((await latestLogFor(email))!.error).toContain('SMTP not configured');
  } finally {
    restoreSmtp();
    await prisma.emailLog.deleteMany({ where: { to: email } });
    await cleanupByEmail(email);
  }
});
