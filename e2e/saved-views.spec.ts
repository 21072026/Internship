import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

// Saved views on admin lists, server-side (#1900). Two admins of one org, one
// admin of another.
//   • save → share → read as the second admin; a PRIVATE view stays private;
//   • PATCH/DELETE of a colleague's view is 403 from the API, another tenant's 404;
//   • this browser's old localStorage presets move up once, then the key is gone.

const PW = 'SavedViews123!';

test.describe('saved views', () => {
  const stamp = `${Date.now()}`;
  const adminA = uniqueEmail('sv2-a');
  const adminB = uniqueEmail('sv2-b');
  const outsider = uniqueEmail('sv2-out');
  const mentor = uniqueEmail('sv2-mentor');
  let orgId = '';
  let otherOrgId = '';

  test.beforeAll(async () => {
    orgId = (await prisma.organization.create({ data: { name: `SV2 Org ${stamp}`, slug: `sv2-${stamp}` } })).id;
    otherOrgId = (await prisma.organization.create({ data: { name: `SV2 Other ${stamp}`, slug: `sv2-other-${stamp}` } })).id;
    await seedUser(adminA, PW, 'ADMIN', `SV2 Admin A ${stamp}`, orgId);
    await seedUser(adminB, PW, 'ADMIN', `SV2 Admin B ${stamp}`, orgId);
    await seedUser(outsider, PW, 'ADMIN', `SV2 Outsider ${stamp}`, otherOrgId);
    await seedUser(mentor, PW, 'MENTOR', `SV2 Mentor ${stamp}`, orgId);
  });

  test.afterAll(async () => {
    await prisma.savedView.deleteMany({ where: { orgId: { in: [orgId, otherOrgId] } } });
    for (const email of [adminA, adminB, outsider, mentor]) await cleanupByEmail(email);
    await prisma.organization.deleteMany({ where: { id: { in: [orgId, otherOrgId] } } });
    await prisma.$disconnect();
  });

  test('a shared view reaches the second admin, a private one does not, and only the author may change either', { tag: '@smoke' }, async ({ browser }) => {
    const a = await (await browser.newContext()).newPage();
    await signInAndSettle(a, adminA, PW, '/admin');
    // Saved through the dialog, shared with the team.
    await a.goto('/admin/users');
    await a.getByTestId('users-search').fill('mentor-lead');
    await a.getByTestId('saved-views-save').click();
    await a.getByTestId('saved-views-name').fill('Mentor leads');
    await a.getByTestId('saved-views-share').check();
    await a.getByTestId('saved-views-confirm').click();
    await expect(a.getByRole('button', { name: 'Mentor leads', exact: true })).toBeVisible();
    // And one private view through the API.
    const priv = await a.request.post('/api/admin/saved-views', { data: { surface: 'users', name: 'Only mine', filters: { search: 'x' } } });
    expect(priv.status()).toBe(201);
    const privateId = (await priv.json()).view.id;
    const shared = (await (await a.request.get('/api/admin/saved-views?surface=users')).json()).views.find((v: { name: string }) => v.name === 'Mentor leads');
    expect(shared).toMatchObject({ visibility: 'ORG', mine: true, filters: { search: 'mentor-lead', filter: 'ALL', statusView: 'ACTIVE' } });

    const b = await (await browser.newContext()).newPage();
    await signInAndSettle(b, adminB, PW, '/admin');
    const seen = (await (await b.request.get('/api/admin/saved-views?surface=users')).json()).views;
    expect(seen.map((v: { name: string }) => v.name)).toEqual(['Mentor leads']);
    expect(seen[0]).toMatchObject({ mine: false, author: `SV2 Admin A ${stamp}` });
    // Reading is not writing: 403 from the handler, for the shared view and the private one.
    for (const id of [shared.id, privateId]) {
      expect((await b.request.patch(`/api/admin/saved-views/${id}`, { data: { name: 'Hijacked' } })).status()).toBe(403);
      expect((await b.request.delete(`/api/admin/saved-views/${id}`)).status()).toBe(403);
    }
    // In the list: the chip applies the filter, and offers no remove button.
    await b.goto('/admin/users');
    await expect(b.getByTestId(`saved-view-remove-${shared.id}`)).toHaveCount(0);
    await b.getByRole('button', { name: 'Mentor leads', exact: true }).click();
    await expect(b.getByTestId('users-search')).toHaveValue('mentor-lead');

    // Another tenant sees nothing and cannot reach it.
    const o = await (await browser.newContext()).newPage();
    await signInAndSettle(o, outsider, PW, '/admin');
    expect((await (await o.request.get('/api/admin/saved-views?surface=users')).json()).views).toEqual([]);
    expect((await o.request.patch(`/api/admin/saved-views/${shared.id}`, { data: { name: 'x' } })).status()).toBe(404);

    // The author may rename, unshare and delete.
    expect((await a.request.patch(`/api/admin/saved-views/${shared.id}`, { data: { visibility: 'PRIVATE' } })).status()).toBe(200);
    expect((await (await b.request.get('/api/admin/saved-views?surface=users')).json()).views).toEqual([]);
    expect((await a.request.delete(`/api/admin/saved-views/${privateId}`)).status()).toBe(200);
  });

  test('old localStorage presets move to the server once, and the key is cleared', async ({ page }) => {
    await signInAndSettle(page, adminB, PW, '/admin');
    await page.evaluate(() => localStorage.setItem('mentors-views', JSON.stringify([{ name: 'Archived ones', filters: { search: '', statusView: 'ARCHIVED' } }])));
    await page.goto('/admin/mentors');
    await expect(page.getByRole('button', { name: 'Archived ones', exact: true })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('mentors-views'))).toBeNull();
    const views = (await (await page.request.get('/api/admin/saved-views?surface=mentors')).json()).views;
    expect(views).toMatchObject([{ name: 'Archived ones', visibility: 'PRIVATE', mine: true, filters: { statusView: 'ARCHIVED' } }]);
    // A reload does not post it again.
    await page.reload();
    await expect(page.getByRole('button', { name: 'Archived ones', exact: true })).toBeVisible();
    expect(await prisma.savedView.count({ where: { orgId, surface: 'mentors' } })).toBe(1);
  });

  test('ADMIN only, and only known surfaces', async ({ page }) => {
    await signInAndSettle(page, adminA, PW, '/admin');
    expect((await page.request.get('/api/admin/saved-views?surface=nope')).status()).toBe(400);
    await page.context().clearCookies();
    await signInAndSettle(page, mentor, PW, '/mentor');
    expect((await page.request.get('/api/admin/saved-views?surface=users')).status()).toBe(403);
    expect((await page.request.post('/api/admin/saved-views', { data: { surface: 'users', name: 'x', filters: {} } })).status()).toBe(403);
  });
});
