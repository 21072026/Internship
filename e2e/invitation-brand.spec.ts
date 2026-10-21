import { test, expect } from '@playwright/test';
import crypto from 'node:crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInViaApi } from './helpers/auth';

/**
 * The invitation landing wears the inviting organization's brand (#1663).
 *
 * An invitee arrives on the default host with nothing but `?token=`; the
 * request's own brand is the default one. A LIVE invitation of this host's
 * world brings the inviting organization's tile and generated mark onto
 * /auth/register. Everything else — no token, an unknown, expired, used or
 * revoked one, and an invitation of the OTHER world (which /api/register
 * refuses like an unknown token, docs/worlds.md) — renders the default tile,
 * so the page tells a token's existence apart from nothing.
 *
 * Synthetic throughout: "Acme Mentoring", a slate tile, a circle-and-square mark.
 */

test.describe.configure({ mode: 'serial' });

const TILE_COLOR = '#1e293b';
const MARK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><circle cx="24" cy="24" r="20" fill="#fde047"/><rect x="18" y="18" width="12" height="12" fill="#111827"/></svg>';
const PASSWORD = 'InviteBrandPass123';
const adminEmail = uniqueEmail('invite-brand-admin');
const orgIds: string[] = [];
let orgId = '';
let otherWorldOrgId = '';
let version = '';

async function invitation(org: string, overrides: Record<string, unknown> = {}) {
  const token = crypto.randomBytes(24).toString('hex');
  await prisma.invitationToken.create({
    data: { token, role: 'MENTEE', orgId: org, expiresAt: new Date(Date.now() + 7 * 86_400_000), ...overrides },
  });
  return token;
}

test.beforeAll(async () => {
  const stamp = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const org = await prisma.organization.create({
    data: { name: `Invite Brand ${stamp}`, slug: `invite-brand-${stamp}`, plan: 'ENTERPRISE', brandName: 'Acme Mentoring', brandColor: '#0e7490', brandTileColor: TILE_COLOR },
  });
  orgId = org.id;
  orgIds.push(org.id);
  await seedUser(adminEmail, PASSWORD, 'ADMIN', 'Invite Brand Admin', { orgId });
});

test.afterAll(async () => {
  await prisma.invitationToken.deleteMany({ where: { orgId: { in: orgIds } } });
  await cleanupByEmail(adminEmail);
  // BrandAsset rows go with the organization that uploaded them (onDelete: Cascade).
  await prisma.organization.deleteMany({ where: { id: { in: orgIds.filter((id) => id !== orgId) } } });
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
  await prisma.$disconnect();
});

test('a live invitation brings the inviting organization\'s mark onto the register page', async ({ request, page }) => {
  // The organization's own ADMIN uploads the mark through the real API.
  const login = await signInViaApi(request, adminEmail, PASSWORD);
  expect(login.ok, `sign-in: ${login.error}`).toBe(true);
  const upload = await request.post(`/api/admin/organizations/${orgId}/brand-mark`, {
    multipart: { file: { name: 'mark.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(MARK_SVG) } },
  });
  expect(upload.status(), await upload.text()).toBe(200);
  version = (await upload.json()).version;
  expect(version).toMatch(/^[0-9a-f]{16}$/);

  const token = await invitation(orgId);
  await page.goto(`/auth/register?token=${token}`);
  const mark = page.locator('img[data-brand-mark]');
  await expect(mark).toBeVisible();
  await expect(mark).toHaveAttribute('src', `/brand/${version}/mark-128.png`);
  expect(await mark.locator('..').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(30, 41, 59)');
  // The form is the ordinary one: the token still rides along.
  await expect(page.locator('input[name="password"]').first()).toBeVisible();
});

test('no token, an unknown, expired, used or revoked one, and the other world\'s invitation all render the default tile', async ({ page }) => {
  test.skip(!version, 'needs the mark uploaded by the previous test');
  // The other world's organization carries the SAME generated mark, so a leak
  // would show — the assertion below is not vacuous.
  const stamp = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const other = await prisma.organization.create({
    data: { name: `Invite Brand Mkt ${stamp}`, slug: `invite-brand-mkt-${stamp}`, vertical: 'MARKETING', brandName: 'Acme Sales', brandTileColor: TILE_COLOR, brandMarkVersion: version },
  });
  otherWorldOrgId = other.id;
  orgIds.push(other.id);

  const cases: Record<string, string> = {
    'no token': '/auth/register',
    unknown: `/auth/register?token=${crypto.randomBytes(24).toString('hex')}`,
    expired: `/auth/register?token=${await invitation(orgId, { expiresAt: new Date(Date.now() - 60_000) })}`,
    used: `/auth/register?token=${await invitation(orgId, { used: true })}`,
    revoked: `/auth/register?token=${await invitation(orgId, { revokedAt: new Date() })}`,
    'other world': `/auth/register?token=${await invitation(otherWorldOrgId)}`,
  };
  for (const [name, url] of Object.entries(cases)) {
    await page.goto(url);
    await expect(page.locator('input[name="password"]').first(), name).toBeVisible();
    await expect(page.locator('img[data-brand-mark]'), name).toHaveCount(0);
  }
});
