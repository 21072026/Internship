import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';
import { open } from '@/lib/secretBox';
import { ROSTER_FEED_SECRET_PURPOSE } from '@/lib/rosterFeed';

// /api/admin/roster-feeds (#1964): the security boundary of a roster feed's
// configuration. Three things are asserted through the API itself, because a
// hidden button is not a control:
//   - the feed's secret goes in and is never read back — not by the create, the
//     list, the detail or the edit, and not into the activity trail — while the
//     row holds a value only the feed's own seal purpose opens;
//   - another tenant's feed answers 404 to read, edit and delete, and is left
//     untouched;
//   - a non-admin is refused.

const PASSWORD = 'RosterPass123';
const SECRET = 'bearer-token-that-must-never-come-back-1964';

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function orgWithAdmin(tag: string) {
  const stamp = `${Date.now()}-${Math.round(performance.now())}-${tag}`;
  const org = await prisma.organization.create({ data: { name: `RF ${tag} ${stamp}`, slug: `rf-${stamp}` } });
  const email = uniqueEmail(`rf-${tag}`);
  const admin = await seedUser(email, PASSWORD, 'ADMIN', `${tag} Admin`);
  await prisma.user.update({ where: { id: admin.id }, data: { orgId: org.id } });
  return { org, email };
}

const feedBody = {
  name: 'HR export',
  transport: 'HTTPS',
  url: 'https://example.com/roster.csv',
  columnMap: { email: 'WorkEmail', fullName: 'DisplayName' },
  cronExpression: '0 3 * * *',
};

test.describe('roster feed configuration API', { tag: '@smoke' }, () => {
  test('an admin creates, edits and deletes a feed; the secret is sealed and never returned', async ({ page }) => {
    const a = await orgWithAdmin('A');
    let feedId: string | undefined;
    try {
      await signInAndSettle(page, a.email, PASSWORD, '/admin');

      // Validation: no email column → 400 with the field named.
      const bad = await page.request.post('/api/admin/roster-feeds', {
        data: { ...feedBody, columnMap: { fullName: 'Name' } },
      });
      expect(bad.status()).toBe(400);
      expect((await bad.json()).errors).toEqual([{ field: 'columnMap.email', code: 'missing_email_column' }]);

      const created = await page.request.post('/api/admin/roster-feeds', { data: { ...feedBody, secret: SECRET } });
      expect(created.status()).toBe(201);
      const createdText = await created.text();
      expect(createdText).not.toContain(SECRET);
      const { feed } = JSON.parse(createdText);
      feedId = feed.id;
      expect(feed.secretSet).toBe(true);
      expect(feed).not.toHaveProperty('secretEnc');
      expect(feed.cronExpression).toBe('0 3 * * *');

      // Stored sealed, stamped with the creator's org, opened only by its purpose.
      const row = await prisma.rosterFeed.findUniqueOrThrow({ where: { id: feedId } });
      expect(row.orgId).toBe(a.org.id);
      expect(row.secretEnc).toBeTruthy();
      expect(row.secretEnc).not.toContain(SECRET);
      expect(open(row.secretEnc!, ROSTER_FEED_SECRET_PURPOSE)).toBe(SECRET);

      const list = await page.request.get('/api/admin/roster-feeds');
      expect(list.status()).toBe(200);
      const listText = await list.text();
      expect(listText).not.toContain(SECRET);
      expect(listText).not.toContain(row.secretEnc!);
      expect(JSON.parse(listText).feeds.map((f: { id: string }) => f.id)).toContain(feedId);

      // An edit that does not mention the secret keeps it.
      const renamed = await page.request.patch(`/api/admin/roster-feeds/${feedId}`, { data: { name: 'Nightly HR' } });
      expect(renamed.status()).toBe(200);
      expect((await renamed.json()).feed).toMatchObject({ name: 'Nightly HR', secretSet: true });
      expect((await prisma.rosterFeed.findUniqueOrThrow({ where: { id: feedId } })).secretEnc).toBe(row.secretEnc);

      // An edit is re-validated as a whole: switching to SFTP without its fields fails.
      const half = await page.request.patch(`/api/admin/roster-feeds/${feedId}`, { data: { transport: 'SFTP' } });
      expect(half.status()).toBe(400);

      // A bad schedule is refused.
      const cron = await page.request.patch(`/api/admin/roster-feeds/${feedId}`, { data: { cronExpression: 'nightly' } });
      expect(cron.status()).toBe(400);

      // Clearing the secret.
      const cleared = await page.request.patch(`/api/admin/roster-feeds/${feedId}`, { data: { clearSecret: true } });
      expect((await cleared.json()).feed.secretSet).toBe(false);
      expect((await prisma.rosterFeed.findUniqueOrThrow({ where: { id: feedId } })).secretEnc).toBeNull();

      // The activity trail names the feed and the kind of change, never the value.
      const trail = await prisma.activityLog.findMany({ where: { targetType: 'roster_feed', targetId: feedId } });
      expect(trail.map((t) => t.action).sort()).toEqual(
        ['roster_feed.created', 'roster_feed.updated', 'roster_feed.updated'].sort(),
      );
      for (const t of trail) expect(t.detail ?? '').not.toContain(SECRET);

      const del = await page.request.delete(`/api/admin/roster-feeds/${feedId}`);
      expect(del.status()).toBe(200);
      expect(await prisma.rosterFeed.findUnique({ where: { id: feedId } })).toBeNull();
      feedId = undefined;
    } finally {
      if (feedId) await prisma.rosterFeed.delete({ where: { id: feedId } }).catch(() => {});
      await cleanupByEmail(a.email);
      await prisma.organization.delete({ where: { id: a.org.id } }).catch(() => {});
    }
  });

  test("another tenant's feed is invisible and untouchable", async ({ page }) => {
    const a = await orgWithAdmin('B');
    const b = await orgWithAdmin('C');
    const foreign = await prisma.rosterFeed.create({
      data: { orgId: b.org.id, name: 'Foreign feed', url: 'https://example.com/b.csv', columnMap: { email: 'Mail' } },
    });
    try {
      await signInAndSettle(page, a.email, PASSWORD, '/admin');
      const list = await (await page.request.get('/api/admin/roster-feeds')).json();
      expect(list.feeds.map((f: { id: string }) => f.id)).not.toContain(foreign.id);
      expect((await page.request.get(`/api/admin/roster-feeds/${foreign.id}`)).status()).toBe(404);
      expect(
        (await page.request.patch(`/api/admin/roster-feeds/${foreign.id}`, { data: { name: 'hijacked' } })).status(),
      ).toBe(404);
      expect((await page.request.delete(`/api/admin/roster-feeds/${foreign.id}`)).status()).toBe(404);
      const after = await prisma.rosterFeed.findUniqueOrThrow({ where: { id: foreign.id } });
      expect(after.name).toBe('Foreign feed');
    } finally {
      await prisma.rosterFeed.delete({ where: { id: foreign.id } }).catch(() => {});
      for (const x of [a, b]) {
        await cleanupByEmail(x.email);
        await prisma.organization.delete({ where: { id: x.org.id } }).catch(() => {});
      }
    }
  });

  test('a mentor is refused', async ({ page }) => {
    const email = uniqueEmail('rf-mentor');
    await seedUser(email, PASSWORD, 'MENTOR', 'Feed Mentor');
    try {
      await signInAndSettle(page, email, PASSWORD, '/mentor');
      expect((await page.request.get('/api/admin/roster-feeds')).status()).toBe(401);
      expect((await page.request.post('/api/admin/roster-feeds', { data: feedBody })).status()).toBe(401);
    } finally {
      await cleanupByEmail(email);
    }
  });
});
