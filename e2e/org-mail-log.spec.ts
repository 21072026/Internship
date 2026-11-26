import crypto from 'node:crypto';
import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { MARKETING_HOST, asHost, signInAndSettle, gotoSettled, signInViaApi } from './helpers/auth';

// The org admin's mail log (#3955): /admin/mail-log and GET /api/admin/mail-log.
// A MARKETING admin (the vertical that had none) sees the mail to their own
// org's people — never another org's row, never a row without an org; a rep
// is refused. SYNTHETIC ONLY.

test.describe.configure({ mode: 'serial' });

const PW = 'MailLog3955!';
const STAMP = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
const H = asHost(MARKETING_HOST);
const orgIds: string[] = [];
const mail: Record<string, string> = {};

test.beforeAll(async () => {
  for (const slug of ['a', 'b']) {
    orgIds.push((await prisma.organization.create({ data: { name: `Acme Mail Log ${slug} ${STAMP}`, slug: `ml-${slug}-${STAMP}`, vertical: 'MARKETING' } })).id);
  }
  mail.admin = uniqueEmail(`ml-admin-${STAMP}`);
  mail.rep = uniqueEmail(`ml-rep-${STAMP}`);
  await seedUser(mail.admin, PW, 'ADMIN', `ML Admin ${STAMP}`, orgIds[0]);
  await seedUser(mail.rep, PW, 'MENTOR', `ML Rep ${STAMP}`, orgIds[0]);
  const at = new Date();
  await prisma.emailLog.createMany({
    data: [
      { orgId: orgIds[0], to: `rep-${STAMP}@shop.example`, subject: `A handed you a lead ${STAMP}`, category: 'mentee-assigned', status: 'SENT', createdAt: at },
      { orgId: orgIds[0], to: `rep-${STAMP}@shop.example`, subject: `Skipped ${STAMP}`, category: 'mentee-assigned', status: 'SKIPPED', error: `Unsubscribed: mentorship_lifecycle`, createdAt: at },
      { orgId: orgIds[0], to: `other-${STAMP}@shop.example`, subject: `Failed ${STAMP}`, category: 'invitation', status: 'FAILED', error: `550 <other-${STAMP}@shop.example> rejected`, createdAt: at },
      { orgId: orgIds[1], to: `foreign-${STAMP}@shop.example`, subject: `Foreign ${STAMP}`, category: 'mentee-assigned', status: 'SENT', createdAt: at },
      { orgId: null, to: `nobody-${STAMP}@shop.example`, subject: `No org ${STAMP}`, category: 'mentee-assigned', status: 'SENT', createdAt: at },
    ],
  });
});

test.afterAll(async () => {
  await prisma.emailLog.deleteMany({ where: { subject: { contains: STAMP } } }).catch(() => {});
  for (const e of Object.values(mail)) await cleanupByEmail(e);
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } }).catch(() => {});
  await prisma.$disconnect();
});

test('an admin of a MARKETING org reads their own mail log, and nobody else\'s rows', { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  const ctx = await playwright.request.newContext({ baseURL, extraHTTPHeaders: H });
  expect((await signInViaApi(ctx, mail.admin, PW, { host: MARKETING_HOST })).error).toBeNull();
  const body = await (await ctx.get('/api/admin/mail-log?days=7')).json();
  const tos = (body.rows as { to: string }[]).map((r) => r.to);
  expect(tos.filter((t) => t.includes(STAMP)).sort()).toEqual([`other-${STAMP}@shop.example`, `rep-${STAMP}@shop.example`, `rep-${STAMP}@shop.example`]);
  // The reason is one short line with any address removed.
  const failed = (body.rows as { status: string; reason: string | null }[]).find((r) => r.status === 'FAILED');
  expect(failed?.reason).toBe('550 <[email]> rejected');
  // Filters.
  const skipped = await (await ctx.get(`/api/admin/mail-log?status=SKIPPED&category=mentee-assigned&to=rep-${STAMP}@shop.example`)).json();
  expect(skipped.rows).toHaveLength(1);
  expect(skipped.rows[0].reason).toBe('Unsubscribed: mentorship_lifecycle');
  await ctx.dispose();

  // A rep is refused.
  const rep = await playwright.request.newContext({ baseURL, extraHTTPHeaders: H });
  expect((await signInViaApi(rep, mail.rep, PW, { host: MARKETING_HOST })).error).toBeNull();
  expect((await rep.get('/api/admin/mail-log')).status()).toBe(403);
  await rep.dispose();
});

test('the page is in the admin menu of a MARKETING org and lists the rows', async ({ page }) => {
  await page.context().setExtraHTTPHeaders(H);
  await signInAndSettle(page, mail.admin, PW, '/admin');
  await gotoSettled(page, '/admin/mail-log');
  await expect(page.getByTestId('mail-log-row').filter({ hasText: `rep-${STAMP}@shop.example` })).toHaveCount(2);
  await page.getByTestId('mail-log-filter-status').selectOption('FAILED');
  await expect(page.getByTestId('mail-log-row')).toHaveCount(1);
  await expect(page.getByTestId('mail-log-row')).toHaveAttribute('data-status', 'FAILED');
  await expect(page.locator('a[href="/admin/mail-log"]').first()).toBeAttached();
});
