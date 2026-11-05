import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail } from './helpers/db';
import { gotoSettled, signInAndSettle, signInViaApi } from './helpers/auth';

// The bell's feed (#3573). The shell mounts two <NotificationBell>s (mobile
// bar + desktop strip); each used to fetch, poll and listen on its own, so every
// signed-in page asked /api/notifications twice. One feed now serves both, over
// the narrow `view=bell` read.
async function seedOrg(stamp: string) {
  const org = await prisma.organization.create({ data: { name: `Bell ${stamp}`, slug: `bell-${stamp}` } });
  const pw = 'BellFeed123!';
  const email = uniqueEmail('bell-admin');
  const admin = await seedUser(email, pw, 'ADMIN', `Bell Admin ${stamp}`, org.id);
  const other = await seedUser(uniqueEmail('bell-other'), pw, 'MENTOR', `Bell Other ${stamp}`, org.id);
  await prisma.notification.createMany({
    data: [
      { userId: admin.id, type: 'message.new', text: `Unread for the bell ${stamp}`, link: '/messages', read: false },
      { userId: admin.id, type: 'meeting.scheduled', text: `Read for the bell ${stamp}`, read: true },
      { userId: other.id, type: 'message.new', text: `Someone else's ${stamp}`, read: false },
    ],
  });
  return { org, email, pw, admin, other };
}

async function dropOrg(orgId: string) {
  await prisma.notification.deleteMany({ where: { user: { orgId } } });
  await prisma.user.deleteMany({ where: { orgId } });
  await prisma.organization.deleteMany({ where: { id: orgId } });
}

test('view=bell answers the caller\'s rows and unread count only', { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const { org, email, pw } = await seedOrg(stamp);
  const api = await playwright.request.newContext({ baseURL });
  try {
    expect((await signInViaApi(api, email, pw)).ok).toBe(true);
    const res = await api.get('/api/notifications?view=bell');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(['items', 'unread']);
    expect(body.unread).toBe(1);
    expect(body.items).toHaveLength(2);
    expect(JSON.stringify(body)).not.toContain("Someone else's");
    // The default shape is unchanged for the native app and /notifications.
    const full = await (await api.get('/api/notifications')).json();
    expect(full).toHaveProperty('total', 2);
    expect(full.items[0]).toHaveProperty('display');
  } finally {
    await api.dispose();
    await dropOrg(org.id);
  }
});

test('one page load asks for the bell once, and both bells show the same count', async ({ page }) => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const { org, email, pw } = await seedOrg(stamp);
  try {
    await signInAndSettle(page, email, pw, '/admin');
    // The landing page's own bell load must be done before counting starts.
    await page.waitForLoadState('networkidle');
    const calls: string[] = [];
    page.on('request', (req) => {
      const url = new URL(req.url());
      if (url.pathname === '/api/notifications' && req.method() === 'GET') calls.push(url.search);
    });
    await gotoSettled(page, '/admin/mentorship');
    await page.waitForLoadState('networkidle');
    expect(calls).toEqual(['?view=bell']);
    // Both bells are mounted (one hidden by CSS) and render the one snapshot.
    const badges = page.getByTestId('notifications-unread-badge');
    await expect(badges).toHaveCount(2);
    await expect(badges.first()).toHaveText('1');
    await expect(badges.last()).toHaveText('1');
  } finally {
    await dropOrg(org.id);
  }
});
