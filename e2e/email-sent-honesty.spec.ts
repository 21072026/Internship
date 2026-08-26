import { test, expect, type APIResponse } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

/**
 * #1431 — four endpoints reported `emailSent: true` when nothing was delivered.
 *
 * `sendEmail` returns NORMALLY when SMTP is unconfigured or demo mode is on; it
 * records a SKIPPED delivery row and returns. The callers defined success as
 * "did not throw", so the API said the set-password link was on its way while
 * the app's own delivery log said SKIPPED. The account existed and nobody could
 * ever sign in to it — the exact situation the already-written UI string
 * `loginCreatedNoEmail` was for, which never fired.
 *
 * The test environment runs with `SMTP_USER: ''` (playwright.config.ts), which
 * is precisely the state the bug needs, so no mocking is required.
 *
 * The assertion that matters most is not `emailSent === false` on its own but
 * that it AGREES with the EmailLog row written by the same request: a response
 * and a delivery log that disagree is the bug, in either direction.
 */

const PW = 'EmailHonesty123!';

async function latestLogFor(to: string) {
  return prisma.emailLog.findFirst({ where: { to }, orderBy: { createdAt: 'desc' }, select: { status: true, error: true } });
}

/** `emailSent` must mirror the delivery row: SENT ⇔ true. */
async function expectAgreement(res: APIResponse, to: string) {
  expect(res.ok()).toBeTruthy();
  const { emailSent } = await res.json();
  const log = await latestLogFor(to);
  expect(log, `no EmailLog row was written for ${to}`).not.toBeNull();
  expect(emailSent, `emailSent=${emailSent} but the delivery log says ${log?.status} (${log?.error ?? ''})`)
    .toBe(log!.status === 'SENT');
  return { emailSent, log: log! };
}

test.describe.configure({ mode: 'serial' });

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('with no SMTP, creating a company login reports that nothing was delivered', async ({ page }) => {
  const adminEmail = uniqueEmail('honesty-admin');
  const companyUserEmail = uniqueEmail('honesty-company-user');
  await seedUser(adminEmail, PW, 'ADMIN', 'Honesty Admin');
  const company = await prisma.company.create({ data: { name: `Honesty Co ${Date.now()}` } });

  try {
    await signInAndSettle(page, adminEmail, PW, '/admin');

    const res = await page.request.post('/api/admin/company-users', {
      data: { companyId: company.id, email: companyUserEmail, fullName: 'Honesty Company User' },
    });
    const { emailSent, log } = await expectAgreement(res, companyUserEmail);

    // In this environment delivery is impossible, so the honest answer is false.
    expect(emailSent).toBe(false);
    expect(log.status).toBe('SKIPPED');
    expect(log.error).toContain('SMTP not configured');

    // The account really was created — that is what makes the lie dangerous
    // rather than merely wrong.
    expect(await prisma.user.count({ where: { email: companyUserEmail } })).toBe(1);
  } finally {
    await prisma.emailLog.deleteMany({ where: { to: companyUserEmail } });
    await cleanupByEmail(companyUserEmail);
    await cleanupByEmail(adminEmail);
    await prisma.company.delete({ where: { id: company.id } }).catch(() => {});
  }
});

test('the same holds for a source login and for an admin password reset', async ({ page }) => {
  const adminEmail = uniqueEmail('honesty-admin2');
  const sourceUserEmail = uniqueEmail('honesty-source-user');
  const menteeEmail = uniqueEmail('honesty-mentee');
  await seedUser(adminEmail, PW, 'ADMIN', 'Honesty Admin 2');
  const mentee = await seedUser(menteeEmail, PW, 'MENTEE', 'Honesty Mentee');
  const source = await prisma.source.create({ data: { name: `Honesty Source ${Date.now()}` } });

  try {
    await signInAndSettle(page, adminEmail, PW, '/admin');

    const sourceRes = await page.request.post('/api/admin/source-users', {
      data: { sourceId: source.id, email: sourceUserEmail, fullName: 'Honesty Source User' },
    });
    expect((await expectAgreement(sourceRes, sourceUserEmail)).emailSent).toBe(false);

    const resetRes = await page.request.post(`/api/admin/users/${mentee.id}/reset-password`);
    expect((await expectAgreement(resetRes, menteeEmail)).emailSent).toBe(false);

    // #987 must stay closed: the reset endpoint still does not hand back a
    // live credential, however loudly it now reports the delivery failure.
    const resetBody = await resetRes.json();
    expect(resetBody.setPasswordUrl).toBeUndefined();
    expect(JSON.stringify(resetBody)).not.toContain('/auth/reset?token=');
  } finally {
    await prisma.emailLog.deleteMany({ where: { to: { in: [sourceUserEmail, menteeEmail] } } });
    await cleanupByEmail(sourceUserEmail);
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(adminEmail);
    await prisma.source.delete({ where: { id: source.id } }).catch(() => {});
  }
});

test('an invitation stops claiming it was sent when it was only skipped', async ({ page }) => {
  // The invite routes already guessed via `!!process.env.SMTP_USER`, which is
  // right about a missing SMTP_USER and wrong about demo mode. They now read the
  // same value as everyone else.
  const adminEmail = uniqueEmail('honesty-admin3');
  const inviteeEmail = uniqueEmail('honesty-invitee');
  await seedUser(adminEmail, PW, 'ADMIN', 'Honesty Admin 3');

  try {
    await signInAndSettle(page, adminEmail, PW, '/admin');
    const res = await page.request.post('/api/invite', { data: { email: inviteeEmail, role: 'MENTEE' } });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.emailSent).toBe(false);
    // …and the link is still returned, because sharing it manually is the whole
    // fallback this honesty enables.
    expect(body.registerUrl ?? body.inviteUrl ?? '').toContain('token=');
  } finally {
    await prisma.emailLog.deleteMany({ where: { to: inviteeEmail } });
    await prisma.invitationToken.deleteMany({ where: { email: inviteeEmail } });
    await cleanupByEmail(adminEmail);
  }
});
