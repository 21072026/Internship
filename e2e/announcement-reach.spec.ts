import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, setOrgFeature } from './helpers/db';
import { gotoSettled, signInAndSettle } from './helpers/auth';

// #1921 (slice 2): announcement reach — recipients, e-mailed and read in the
// app, as counts. Its own org, on the default 180-day notification window.
//
//   A  to 6 people, 2 e-mailed, 3 read in the bell → "read by 3 of 6 (50%)"
//   B  to 1 person, who read it → withheld: one recipient is one person
//   C  to 6 people, 200 days ago → withheld: older than the retention window,
//      where the sweep thins the bell rows and a count would be wrong
//
// The history API, the admin screen and the registry report say the same.

const PW = 'AnnReach123!';
const DAY = 24 * 60 * 60 * 1000;

test('announcement reach counts in-app reads, withheld for small audiences and pruned history', async ({ page }) => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const org = await prisma.organization.create({ data: { name: `Ann Reach ${stamp}`, slug: `ann-reach-${stamp}` } });
  try {
    const adminEmail = uniqueEmail('ar-admin');
    const admin = await seedUser(adminEmail, PW, 'ADMIN', 'AR Admin', org.id);
    const people = await Promise.all(Array.from({ length: 6 }, (_, i) => seedUser(uniqueEmail(`ar-p${i}`), PW, 'MENTEE', `AR Person ${i}`, org.id)));

    const announce = async (text: string, recipients: typeof people, readBy: number, extra: { createdAt?: Date; emailedCount?: number; targeted?: boolean } = {}) => {
      const a = await prisma.announcement.create({
        data: { orgId: org.id, text, sentById: admin.id, recipientCount: recipients.length, emailedCount: extra.emailedCount ?? 0, targeted: extra.targeted ?? false, status: 'SENT', ...(extra.createdAt ? { createdAt: extra.createdAt } : {}) },
      });
      await prisma.notification.createMany({
        data: recipients.map((p, i) => ({ userId: p.id, type: 'announcement', text, announcementId: a.id, read: i < readBy, ...(extra.createdAt ? { createdAt: extra.createdAt } : {}) })),
      });
      return a;
    };
    const a = await announce(`Reach A ${stamp}`, people, 3, { emailedCount: 2 });
    const b = await announce(`Reach B ${stamp}`, people.slice(0, 1), 1, { targeted: true });
    const c = await announce(`Reach C ${stamp}`, people, 4, { createdAt: new Date(Date.now() - 200 * DAY) });

    await signInAndSettle(page, adminEmail, PW, '/admin');
    const hist = await (await page.request.get('/api/admin/announcements')).json();
    const row = (id: string) => hist.announcements.find((x: { id: string }) => x.id === id);
    expect(row(a.id)).toMatchObject({ recipientCount: 6, emailedCount: 2, delivered: 6, read: 3, readRate: 50, readWithheld: null });
    expect(row(b.id)).toMatchObject({ recipientCount: 1, delivered: 1, read: null, readRate: null, readWithheld: 'small_audience' });
    expect(row(c.id)).toMatchObject({ recipientCount: 6, delivered: 6, read: null, readRate: null, readWithheld: 'pruned' });

    // The screen shows the count for A and says why for B and C.
    await gotoSettled(page, '/admin/announcements');
    await expect(page.getByTestId(`announcement-read-${a.id}`)).toContainText('3');
    await expect(page.getByTestId(`announcement-read-${a.id}`)).toContainText('50');
    await expect(page.getByTestId(`announcement-read-${b.id}`)).toHaveCount(0);
    await expect(page.getByTestId(`announcement-read-withheld-${b.id}`)).toBeVisible();
    await expect(page.getByTestId(`announcement-read-withheld-${c.id}`)).toBeVisible();

    // The registry report: one row per announcement, the same counts, nobody named.
    await setOrgFeature(org.id, 'ADVANCED_ANALYTICS', true);
    const report = await (await page.request.get('/api/admin/reports/announcement-reach')).json();
    expect(report.rows).toContainEqual(expect.objectContaining({ announcement: `Reach A ${stamp}`, recipients: 6, emailed: 2, read: 3, readRate: 50 }));
    expect(report.rows).toContainEqual(expect.objectContaining({ announcement: `Reach B ${stamp}`, recipients: 1, read: null, readRate: null }));
    expect(report.rows).toContainEqual(expect.objectContaining({ announcement: `Reach C ${stamp}`, recipients: 6, read: null }));
    expect(JSON.stringify(report.rows)).not.toContain('AR Person');
  } finally {
    await prisma.orgEntitlement.deleteMany({ where: { orgId: org.id } });
    const ids = (await prisma.announcement.findMany({ where: { orgId: org.id }, select: { id: true } })).map((x) => x.id);
    await prisma.notification.deleteMany({ where: { announcementId: { in: ids } } });
    await prisma.announcement.deleteMany({ where: { orgId: org.id } });
    await prisma.user.deleteMany({ where: { orgId: org.id } });
    await prisma.organization.deleteMany({ where: { id: org.id } });
  }
});
