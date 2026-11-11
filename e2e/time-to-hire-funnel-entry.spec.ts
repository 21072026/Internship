import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail, setOrgFeature } from './helpers/db';
import { signInViaApi } from './helpers/auth';

// #1505: time to hire starts when the relation ENTERED the funnel, not when
// the pair was made. Its own org on the built-in stages. Two pairs made 150
// days ago and hired 10 days ago: one has always been in the funnel (no
// stamp, like every row from before #1503) and reads 140 days exactly as it
// did; the other was a coaching pair that entered the funnel 40 days ago and
// reads 30. The admin funnel (median of 30 and 140 = 85) and the mentor's
// average days to hired (also 85) both follow.

const PW = 'TimeToHire123!';
const DAY = 24 * 60 * 60 * 1000;
const ago = (d: number) => new Date(Date.now() - d * DAY);

test('time to hire counts from funnel entry; a row without one from the pairing', async ({ page }) => {
  const request = page.request;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const org = await prisma.organization.create({ data: { name: `TTH ${stamp}`, slug: `tth-${stamp}` } });
  const emails = { admin: uniqueEmail('tth-admin'), mentor: uniqueEmail('tth-mentor'), a: uniqueEmail('tth-a'), b: uniqueEmail('tth-b') };
  try {
    await setOrgFeature(org.id, 'ADVANCED_ANALYTICS', true);
    await seedUser(emails.admin, PW, 'ADMIN', 'TTH Admin', org.id);
    const mentor = await seedUser(emails.mentor, PW, 'MENTOR', 'TTH Mentor', org.id);
    await prisma.user.update({ where: { id: mentor.id }, data: { mentorCapacity: 10 } });

    expect((await signInViaApi(request, emails.admin, PW)).ok).toBe(true);
    // The funnel's completion stage is the org's own last on-path stage.
    const empty = await (await request.get('/api/admin/analytics/funnel')).json();
    const completionKey: string = empty.timeToHire.completionKey;
    expect(completionKey).toBeTruthy();

    const hired = async (email: string, funnelEnteredAt: Date | null) => {
      const mentee = await seedUser(email, PW, 'MENTEE', 'TTH Mentee', org.id);
      const rel = await prisma.mentorshipRelation.create({
        data: { orgId: org.id, mentorId: mentor.id, menteeId: mentee.id, pipelineStatus: completionKey, startDate: ago(150), funnelEnteredAt },
      });
      await prisma.statusChange.create({ data: { relationId: rel.id, fromStatus: 'APPLICATION_100', toStatus: completionKey, createdAt: ago(10) } });
    };
    await hired(emails.a, null);
    await hired(emails.b, ago(40));

    const funnel = await (await request.get('/api/admin/analytics/funnel')).json();
    expect(funnel.timeToHire).toMatchObject({ completionKey, completed: 2, medianDays: 85, avgDays: 85 });

    const mine = await (await request.get('/api/mentor/analytics')).json();
    expect(mine.avgDaysToHired).toBe(85);
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { orgId: org.id } });
    for (const email of Object.values(emails)) await cleanupByEmail(email);
    await prisma.orgEntitlement.deleteMany({ where: { orgId: org.id } });
    await prisma.organization.deleteMany({ where: { id: org.id } });
  }
});
