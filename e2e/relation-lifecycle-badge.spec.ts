import { test, expect } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, gotoSettled } from './helpers/auth';

// The lifecycle badge (#1774): a paused pairing reads "Paused" (TR
// "Duraklatıldı") on /admin/mentorship and on the mentee's portal, an early
// end shows its reason on hover, and the PAUSED / ENDED filter chips narrow
// the list to exactly those pairings.

test.afterAll(async () => prisma.$disconnect());

const PW = 'BadgePass123!';

test('paused and ended pairings carry their state, in EN and TR', async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  const s = `${Date.now()}-${randomBytes(3).toString('hex')}`;
  const org = await prisma.organization.create({ data: { name: `Badge ${s}`, slug: `badge-${s}` } });
  const emails = ['lb-admin', 'lb-mentor', 'lb-paused', 'lb-ended', 'lb-live'].map((p) => uniqueEmail(p));
  const [adminEmail, mentorEmail, pausedEmail, endedEmail, liveEmail] = emails;
  try {
    await seedUser(adminEmail, PW, 'ADMIN', 'Badge Admin', org.id);
    const mentor = await seedUser(mentorEmail, PW, 'MENTOR', 'Badge Mentor', org.id);
    const pausedMentee = await seedUser(pausedEmail, PW, 'MENTEE', 'Paused Mentee', org.id);
    const endedMentee = await seedUser(endedEmail, PW, 'MENTEE', 'Ended Mentee', org.id);
    const liveMentee = await seedUser(liveEmail, PW, 'MENTEE', 'Live Mentee', org.id);
    const paused = await prisma.mentorshipRelation.create({
      data: { orgId: org.id, mentorId: mentor.id, menteeId: pausedMentee.id, lifecycleState: 'PAUSED', pausedAt: new Date() },
    });
    const ended = await prisma.mentorshipRelation.create({
      data: { orgId: org.id, mentorId: mentor.id, menteeId: endedMentee.id, status: 'COMPLETED', lifecycleState: 'ENDED_EARLY', endReasonCode: 'no_fit', completedAt: new Date() },
    });
    const live = await prisma.mentorshipRelation.create({ data: { orgId: org.id, mentorId: mentor.id, menteeId: liveMentee.id } });

    await signInAndSettle(page, adminEmail, PW, '/admin');
    await page.context().addCookies([{ name: 'locale', value: 'en', url: baseURL! }]);
    await gotoSettled(page, '/admin/mentorship');
    const pausedBadge = page.getByTestId(`mentorship-row-${paused.id}`).getByTestId('relation-lifecycle-badge');
    await expect(pausedBadge).toHaveText('Paused');
    const endedBadge = page.getByTestId(`mentorship-row-${ended.id}`).getByTestId('relation-lifecycle-badge');
    await expect(endedBadge).toHaveAttribute('title', 'Not a good fit');
    // A live pair already says "Active": no lifecycle chip.
    await expect(page.getByTestId(`mentorship-row-${live.id}`).getByTestId('relation-lifecycle-badge')).toHaveCount(0);

    // The filter chips.
    await page.getByTestId('mentorship-filter-paused').click();
    await expect(page.getByTestId(`mentorship-row-${paused.id}`)).toBeVisible();
    await expect(page.getByTestId(`mentorship-row-${ended.id}`)).toHaveCount(0);
    await page.getByTestId('mentorship-filter-ended').click();
    await expect(page.getByTestId(`mentorship-row-${ended.id}`)).toBeVisible();
    await expect(page.getByTestId(`mentorship-row-${paused.id}`)).toHaveCount(0);

    // Turkish.
    await page.context().addCookies([{ name: 'locale', value: 'tr', url: baseURL! }]);
    await gotoSettled(page, '/admin/mentorship');
    await expect(page.getByTestId(`mentorship-row-${paused.id}`).getByTestId('relation-lifecycle-badge')).toHaveText('Duraklatıldı');

    // The mentee's own portal says it too.
    await page.context().clearCookies();
    await signInAndSettle(page, pausedEmail, PW, '/portal');
    await page.context().addCookies([{ name: 'locale', value: 'en', url: baseURL! }]);
    await gotoSettled(page, '/portal');
    await expect(page.getByTestId('relation-lifecycle-badge').first()).toHaveText('Paused');
  } finally {
    for (const e of emails) await cleanupByEmail(e);
    await prisma.organization.deleteMany({ where: { id: org.id } }).catch(() => {});
  }
});
