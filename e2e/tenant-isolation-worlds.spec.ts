import crypto from 'crypto';
import { test, expect, type Page } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { MARKETING_HOST, asHost, signInAndSettle, signInViaApi } from './helpers/auth';

// Cross-world isolation (docs/worlds.md § Super admin, § Internship-only surfaces).
//
// Two maintainer rules, both directions asserted:
//   1. An internship-only surface (the newsletter, "e-mail your mentees",
//      testimonials, mentorship requests) is not merely hidden for a MARKETING
//      org: its URL is a 404 and its API a capability refusal.
//   2. Super admin is PER WORLD: the MARKETING super admin lists and manages
//      MARKETING organizations only, the INTERNSHIP one INTERNSHIP ones only,
//      and a new organization is typed by an explicit vertical of the caller's
//      own world.

const PASSWORD = 'WorldsIso123!';
const emails: string[] = [];
const orgIds: string[] = [];

async function org(vertical: 'INTERNSHIP' | 'MARKETING', label: string) {
  const stamp = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const row = await prisma.organization.create({
    data: { name: `Iso ${label} ${stamp}`, slug: `iso-${label}-${stamp}`, vertical },
  });
  orgIds.push(row.id);
  return row;
}

async function admin(label: string, orgId: string | null, superAdmin = false) {
  const email = uniqueEmail(`iso-${label}`);
  emails.push(email);
  const user = await seedUser(email, PASSWORD, 'ADMIN', `Iso ${label}`, orgId);
  if (superAdmin) await prisma.user.update({ where: { id: user.id }, data: { isSuperAdmin: true } });
  return { email, user };
}

/** Sign `page`'s context in through the API on `host` (omit for the internship world). */
async function signIn(page: Page, email: string, host?: string) {
  await page.context().setExtraHTTPHeaders(host ? asHost(host) : {});
  const res = await signInViaApi(page.request, email, PASSWORD, { host });
  expect(res.ok, `sign-in failed: ${res.error}`).toBe(true);
}

test.afterAll(async () => {
  for (const email of emails) await cleanupByEmail(email);
  await prisma.invitationToken.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.user.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.pipelineStage.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
  await prisma.$disconnect();
});

test(
  'a MARKETING admin gets a 404 on internship-only pages and a capability refusal from their APIs',
  { tag: '@smoke' },
  async ({ page }) => {
    const mkt = await org('MARKETING', 'gate');
    const { email } = await admin('mkt-admin', mkt.id);
    await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
    await signInAndSettle(page, email, PASSWORD, '/admin');

    // The sidebar has no link to them…
    const nav = page.locator('aside nav').first();
    await expect(nav.getByRole('link', { name: 'Companies', exact: true })).toBeVisible();
    await expect(nav.locator('a[href="/admin/newsletters"]')).toHaveCount(0);
    await expect(nav.locator('a[href="/admin/email"]')).toHaveCount(0);

    // …and the URL itself is closed, direct navigation included.
    for (const path of ['/admin/newsletters', '/admin/email', '/admin/testimonials', '/newsletters']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: 'Page not found' }), path).toBeVisible({ timeout: 20_000 });
    }

    // The APIs refuse with the machine-readable capability shape.
    const refusals = [
      page.request.get('/api/admin/newsletters'),
      page.request.post('/api/admin/newsletters', { data: { title: 'x' } }),
      page.request.get('/api/admin/newsletters/templates'),
      page.request.get('/api/newsletters'),
      page.request.get('/api/admin/testimonials'),
      page.request.get('/api/admin/mentorship-requests'),
      page.request.get('/api/admin/goal-templates'),
      page.request.get('/api/re-engagement'),
    ];
    for (const res of await Promise.all(refusals)) {
      expect(res.status(), res.url()).toBe(403);
      expect((await res.json()).code, res.url()).toBe('capability_unavailable');
    }
  }
);

test('an INTERNSHIP admin keeps the newsletter and its API — the gate is a no-op there', async ({ page }) => {
  const int = await org('INTERNSHIP', 'keep');
  const { email } = await admin('int-admin', int.id);
  await signInAndSettle(page, email, PASSWORD, '/admin');
  await page.goto('/admin/newsletters');
  await expect(page.getByRole('heading', { name: 'Page not found' })).toHaveCount(0);
  expect((await page.request.get('/api/admin/newsletters')).status()).toBe(200);
});

test(
  'the MARKETING super admin lists and manages only MARKETING organizations',
  { tag: '@smoke' },
  async ({ page }) => {
    const home = await org('MARKETING', 'sa-home');
    const otherMkt = await org('MARKETING', 'sa-other');
    const intOrg = await org('INTERNSHIP', 'sa-foreign');
    const { email } = await admin('mkt-super', home.id, true);
    await signIn(page, email, MARKETING_HOST);

    const listed = await (await page.request.get('/api/admin/organizations')).json();
    expect(listed.superAdmin).toBe(true);
    expect(listed.world).toBe('MARKETING');
    expect(listed.verticals).toEqual(['MARKETING']);
    const ids = (listed.organizations as { id: string; vertical: string }[]).map((o) => o.id);
    expect(ids).toEqual(expect.arrayContaining([home.id, otherMkt.id]));
    expect(ids).not.toContain(intOrg.id);
    expect((listed.organizations as { vertical: string }[]).every((o) => o.vertical === 'MARKETING')).toBe(true);

    // The INTERNSHIP org is out of reach: invite-admin reads as not found,
    // PATCH and the stage editor as forbidden, and nothing was written.
    const invite = await page.request.post(`/api/admin/organizations/${intOrg.id}/invite-admin`, { data: { email: '' } });
    expect(invite.status()).toBe(404);
    expect(await prisma.invitationToken.count({ where: { orgId: intOrg.id } })).toBe(0);
    const patch = await page.request.patch('/api/admin/organizations', { data: { id: intOrg.id, plan: 'ENTERPRISE' } });
    expect(patch.status()).toBe(403);
    expect((await prisma.organization.findUnique({ where: { id: intOrg.id } }))?.plan).toBe('FREE');
    expect((await page.request.get(`/api/admin/organizations/${intOrg.id}/pipeline-stages`)).status()).toBe(403);

    // Its own world's other org is manageable.
    const ownPatch = await page.request.patch('/api/admin/organizations', { data: { id: otherMkt.id, plan: 'PRO' } });
    expect(ownPatch.status(), await ownPatch.text()).toBe(200);
    // …but not movable into the other world.
    const move = await page.request.patch('/api/admin/organizations', { data: { id: otherMkt.id, vertical: 'INTERNSHIP' } });
    expect(move.status()).toBe(403);
    expect((await move.json()).code).toBe('vertical_other_world');
    expect((await prisma.organization.findUnique({ where: { id: otherMkt.id } }))?.vertical).toBe('MARKETING');

    // Creating: the vertical is required and must be this world's.
    const stamp = Date.now();
    const noVertical = await page.request.post('/api/admin/organizations', { data: { name: `Iso NoV ${stamp}` } });
    expect(noVertical.status()).toBe(400);
    expect((await noVertical.json()).code).toBe('vertical_required');
    const otherWorld = await page.request.post('/api/admin/organizations', {
      data: { name: `Iso OtherW ${stamp}`, vertical: 'INTERNSHIP' },
    });
    expect(otherWorld.status()).toBe(403);
    expect((await otherWorld.json()).code).toBe('vertical_other_world');
    const created = await page.request.post('/api/admin/organizations', {
      data: { name: `Iso Mkt New ${stamp}`, vertical: 'MARKETING' },
    });
    expect(created.status(), await created.text()).toBe(201);
    const newOrg = (await created.json()).organization as { id: string; vertical: string };
    orgIds.push(newOrg.id);
    expect(newOrg.vertical).toBe('MARKETING');
    expect(await prisma.organization.count({ where: { name: { in: [`Iso NoV ${stamp}`, `Iso OtherW ${stamp}`] } } })).toBe(0);
  }
);

test('the INTERNSHIP super admin does not see or reach MARKETING organizations', async ({ page }) => {
  const mkt = await org('MARKETING', 'int-sa-foreign');
  const own = await org('INTERNSHIP', 'int-sa-own');
  const { email } = await admin('int-super', own.id, true);
  await signIn(page, email);

  const listed = await (await page.request.get('/api/admin/organizations')).json();
  expect(listed.superAdmin).toBe(true);
  expect(listed.world).toBe('INTERNSHIP');
  const rows = listed.organizations as { id: string; vertical: string }[];
  expect(rows.map((o) => o.id)).toContain(own.id);
  expect(rows.map((o) => o.id)).not.toContain(mkt.id);
  expect(rows.some((o) => o.vertical === 'MARKETING')).toBe(false);

  const invite = await page.request.post(`/api/admin/organizations/${mkt.id}/invite-admin`, { data: { email: '' } });
  expect(invite.status()).toBe(404);
  expect((await page.request.get(`/api/admin/organizations/${mkt.id}/pipeline-stages`)).status()).toBe(403);
  const create = await page.request.post('/api/admin/organizations', {
    data: { name: `Iso IntSA ${Date.now()}`, vertical: 'MARKETING' },
  });
  expect(create.status()).toBe(403);

  // On the marketing host this session is nobody's, super admin or not.
  const elsewhere = await page.request.get('/api/admin/organizations', { headers: asHost(MARKETING_HOST) });
  expect([401, 403]).toContain(elsewhere.status());
});
