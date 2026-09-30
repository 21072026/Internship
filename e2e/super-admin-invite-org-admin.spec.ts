import crypto from 'crypto';
import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { MARKETING_HOST, asHost, signInAndSettle, signInAsFreshUser, gotoSettled } from './helpers/auth';
import { freshIp } from './helpers/rateLimit';

// The first admin of a new MARKETING org (docs/worlds.md § İkinci dünyaya davet).
//
// POST /api/invite always writes into the CALLER's org, so before this route a
// brand-new marketing tenant had no way to get anybody in. A super admin now
// invites a person as ADMIN into any org from /admin/organizations; the link it
// returns is on the target org's own product host, and registering through it
// creates the ADMIN account in that org's world.

const PASSWORD = 'SuperInvite123!';
const emails: string[] = [];
const orgIds: string[] = [];

async function seedSuperAdmin(label: string) {
  const email = uniqueEmail(`sa-invite-${label}`);
  emails.push(email);
  const user = await seedUser(email, PASSWORD, 'ADMIN', 'Super Invite Admin');
  await prisma.user.update({ where: { id: user.id }, data: { isSuperAdmin: true } });
  return { email, user };
}

async function seedMarketingOrg(label: string) {
  const stamp = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const org = await prisma.organization.create({
    data: { name: `SA Invite ${label} ${stamp}`, slug: `sa-invite-${label}-${stamp}`, vertical: 'MARKETING' },
  });
  orgIds.push(org.id);
  return org;
}

test.afterAll(async () => {
  await prisma.invitationToken.deleteMany({ where: { orgId: { in: orgIds } } });
  for (const email of emails) await cleanupByEmail(email);
  await prisma.user.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.pipelineStage.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
  await prisma.$disconnect();
});

test(
  'a super admin invites the first ADMIN of a MARKETING org from the organizations screen, and the link registers them there',
  { tag: '@smoke' },
  async ({ page }) => {
    const { email: superEmail } = await seedSuperAdmin('ui');
    const org = await seedMarketingOrg('ui');
    const invitee = uniqueEmail('sa-invitee');
    emails.push(invitee);

    await signInAndSettle(page, superEmail, PASSWORD, '/admin');
    await gotoSettled(page, '/admin/organizations');

    await page.getByTestId(`org-invite-admin-${org.id}`).click();
    const form = page.getByTestId('invite-admin-form');
    await expect(form).toBeVisible();
    await page.getByTestId('invite-admin-email').fill(invitee);
    await page.getByTestId('invite-admin-submit').click();

    const linkInput = page.getByTestId('invite-admin-link');
    await expect(linkInput).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('invite-admin-copy')).toBeVisible();
    await expect(page.getByTestId('invite-admin-mail-status')).toBeVisible();
    const link = new URL(await linkInput.inputValue());
    // No publicHost on the org → its world's origin: the marketing host (#2495).
    expect(link.hostname).toBe(org.publicHost ?? MARKETING_HOST);
    expect(link.pathname).toBe('/auth/register');
    const token = link.searchParams.get('token') ?? '';
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    const row = await prisma.invitationToken.findUnique({ where: { token } });
    expect(row?.role).toBe('ADMIN');
    expect(row?.orgId).toBe(org.id);
    expect(row?.email).toBe(invitee);

    // The cross-tenant act is on the audit trail, without the raw address.
    const audit = await prisma.activityLog.findFirst({
      where: { action: 'organization.admin_invited', targetId: org.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit?.detail ?? '').toContain('ADMIN');
    expect(audit?.detail ?? '').not.toContain(invitee);

    // Register through the link on the marketing host.
    await page.goto('about:blank');
    await page.context().clearCookies({ name: /next-auth\.session-token/ });
    await page.context().setExtraHTTPHeaders({ ...asHost(MARKETING_HOST), ...freshIp('sa-invite-register') });
    await page.goto(`/auth/register?token=${token}`);
    await page.fill('input[name="token"]', token);
    await page.fill('input[name="fullName"]', 'First Marketing Admin');
    await page.fill('input[name="email"]', invitee);
    await page.fill('input[name="password"]', PASSWORD);
    await page.fill('input[name="confirmPassword"]', PASSWORD);
    await page.check('input[name="consent"]');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.includes('/auth/signin'), { timeout: 20_000 });

    const created = await prisma.user.findFirst({ where: { email: invitee }, select: { role: true, orgId: true } });
    expect(created).toEqual({ role: 'ADMIN', orgId: org.id });

    // …and signs in on the marketing host as that org's admin.
    await signInAsFreshUser(page, invitee, PASSWORD, '/admin');
  }
);

test('a plain tenant ADMIN is refused; an address already in that world is a 409; a pending one too', async ({ page, request }) => {
  const org = await seedMarketingOrg('guard');

  // A tenant ADMIN of that very org — still not a super admin.
  const tenantAdminEmail = uniqueEmail('sa-invite-tenant-admin');
  emails.push(tenantAdminEmail);
  await seedUser(tenantAdminEmail, PASSWORD, 'ADMIN', 'Tenant Admin', org.id);
  await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
  await signInAndSettle(page, tenantAdminEmail, PASSWORD, '/admin');
  const refused = await page.request.post(`/api/admin/organizations/${org.id}/invite-admin`, {
    data: { email: uniqueEmail('sa-invite-nobody') },
  });
  expect(refused.status()).toBe(403);
  expect(await prisma.invitationToken.count({ where: { orgId: org.id } })).toBe(0);

  // Anonymous: 401.
  const anon = await request.post(`/api/admin/organizations/${org.id}/invite-admin`, { data: { email: '' } });
  expect(anon.status()).toBe(401);

  // The super admin.
  const { email: superEmail } = await seedSuperAdmin('guard');
  await page.context().setExtraHTTPHeaders({});
  await signInAsFreshUser(page, superEmail, PASSWORD, '/admin');
  const post = (body: Record<string, unknown>, orgId = org.id) =>
    page.request.post(`/api/admin/organizations/${orgId}/invite-admin`, { data: body });

  // Already has an account in the MARKETING world (the tenant admin above).
  const taken = await post({ email: tenantAdminEmail });
  expect(taken.status()).toBe(409);
  expect((await taken.json()).code).toBe('email_taken_in_world');

  // An internship-only address is NOT taken in the marketing world.
  const internshipOnly = uniqueEmail('sa-invite-internship-only');
  emails.push(internshipOnly);
  await seedUser(internshipOnly, PASSWORD, 'MENTOR', 'Internship Only');
  const second = await post({ email: internshipOnly });
  expect(second.status(), await second.text()).toBe(201);
  const body = await second.json();
  expect(body).toMatchObject({ emailSent: expect.any(Boolean), mailError: expect.any(Boolean) });
  expect(typeof body.invitationId).toBe('string');

  // …and inviting it again while that invitation is open is refused.
  const pending = await post({ email: internshipOnly });
  expect(pending.status()).toBe(409);
  expect((await pending.json()).code).toBe('invitation_pending');

  // An email-less link is always allowed; an unknown org is a 404.
  expect((await post({ email: '', label: 'hand-over' })).status()).toBe(201);
  expect((await post({ email: '' }, 'no-such-org')).status()).toBe(404);
});

test('on a 360px phone the invite panel and its link stay inside the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  const { email: superEmail } = await seedSuperAdmin('phone');
  const org = await seedMarketingOrg('phone');

  await signInAndSettle(page, superEmail, PASSWORD, '/admin');
  await gotoSettled(page, '/admin/organizations');
  // The action sits in the list's horizontally scrollable table on a phone.
  const action = page.getByTestId(`org-invite-admin-${org.id}`);
  await action.scrollIntoViewIfNeeded();
  await action.click();
  await expect(page.getByTestId('invite-admin-form')).toBeVisible();
  await page.getByTestId('invite-admin-submit').click();
  await expect(page.getByTestId('invite-admin-link')).toBeVisible({ timeout: 15_000 });

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, 'the page scrolls sideways').toBeLessThanOrEqual(0);
  for (const id of ['invite-admin-panel', 'invite-admin-link', 'invite-admin-copy']) {
    const box = await page.getByTestId(id).boundingBox();
    expect(box, id).not.toBeNull();
    expect(box!.x, `${id} starts off-screen`).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width, `${id} ends off-screen`).toBeLessThanOrEqual(360);
  }
});
