import crypto from 'node:crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { signInAndSettle, gotoSettled, MARKETING_HOST, asHost } from './helpers/auth';
import { freshIp } from './helpers/rateLimit';

/**
 * The partner list says where an invitation stands (#3962).
 *
 * A partner that was never invited shows the "Send invitation" button. Once an
 * invitation is out (the admin sent it, or an approved application did), the
 * button gives way to "Invitation sent · <when>" and a small "Send again", which
 * withdraws the earlier link. When the partner opens its account both are gone.
 *
 * SYNTHETIC ONLY: a throwaway MARKETING org per run.
 */

const PW = 'AffInviteStatus123!';
const host = asHost(MARKETING_HOST);
let orgId = '';
let adminEmail = '';
let partnerId = '';
let partnerEmail = '';
const code = `ist-${crypto.randomBytes(3).toString('hex')}`;
const contexts: APIRequestContext[] = [];

test.beforeAll(async () => {
  const stamp = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  orgId = (await prisma.organization.create({ data: { name: `Acme Sales ${stamp}`, slug: `aff-ist-${stamp}`, vertical: 'MARKETING' } })).id;
  adminEmail = uniqueEmail('aff-ist-admin');
  partnerEmail = uniqueEmail('aff-ist-partner');
  await seedUser(adminEmail, PW, 'ADMIN', 'Status Admin', { orgId });
  partnerId = (await prisma.affiliatePartner.create({ data: { orgId, code, displayName: 'Status Partner', contactEmail: partnerEmail } })).id;
});

test.afterAll(async () => {
  for (const ctx of contexts) await ctx.dispose();
  await prisma.affiliatePartner.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.invitationToken.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.auditLog.deleteMany({ where: { orgId } }).catch(() => {});
  for (const e of [adminEmail, partnerEmail]) await cleanupByEmail(e);
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => {});
  await prisma.$disconnect();
});

test('the partner list shows a sent invitation instead of the invite button', async ({ page, playwright, baseURL }) => {
  await page.context().setExtraHTTPHeaders(host);
  await signInAndSettle(page, adminEmail, PW, '/admin');
  await gotoSettled(page, '/admin/affiliates/partners');

  // Never invited: the button, no status line.
  const inviteButton = page.getByTestId(`affiliate-invite-${code}`);
  await expect(inviteButton).toBeVisible();
  await expect(page.getByTestId(`affiliate-invited-${code}`)).toHaveCount(0);

  // Invited: the status line with "Send again" replaces the button.
  await inviteButton.click();
  const status = page.getByTestId(`affiliate-invited-${code}`);
  await expect(status).toBeVisible();
  await expect(inviteButton).toHaveCount(0);
  const first = await prisma.invitationToken.findFirstOrThrow({ where: { orgId, partnerId, revokedAt: null } });

  // Send again withdraws the earlier link and leaves one open invitation.
  await page.getByTestId(`affiliate-reinvite-${code}`).click();
  await expect.poll(async () => (await prisma.invitationToken.findUnique({ where: { id: first.id } }))?.revokedAt ?? null).not.toBeNull();
  const open = await prisma.invitationToken.findMany({ where: { orgId, partnerId, revokedAt: null, used: false } });
  expect(open).toHaveLength(1);
  await expect(status).toBeVisible();
  await expect(inviteButton).toHaveCount(0);

  // An expired invitation still counts as sent, and says so.
  await prisma.invitationToken.update({ where: { id: open[0].id }, data: { expiresAt: new Date(Date.now() - 60_000) } });
  await page.reload();
  await expect(status).toBeVisible();
  await expect(page.getByTestId(`affiliate-reinvite-${code}`)).toBeVisible();
  await expect(inviteButton).toHaveCount(0);
  await prisma.invitationToken.update({ where: { id: open[0].id }, data: { expiresAt: new Date(Date.now() + 86_400_000) } });

  // The partner registers: neither the status line nor the button remain.
  const anon = await playwright.request.newContext({ baseURL });
  contexts.push(anon);
  const res = await anon.post('/api/register', {
    headers: { ...host, ...freshIp('register affiliate-invite-status') },
    data: { token: open[0].token, email: partnerEmail, password: PW, fullName: 'Status Partner', consent: true },
  });
  expect(res.status()).toBe(201);
  await page.reload();
  await expect(page.getByTestId(`affiliate-partner-${code}`)).toBeVisible();
  await expect(status).toHaveCount(0);
  await expect(inviteButton).toHaveCount(0);
  await expect(page.getByTestId(`affiliate-reinvite-${code}`)).toHaveCount(0);
});
