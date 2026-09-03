import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

// Bulk invitations (#2070). The load-bearing assertion is the invariant the
// feature is built around: the dry run's `invitable` count is exactly what the
// real run creates for the same input — one validator, two modes.

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function signIn(page: import('@playwright/test').Page, email: string, password: string) {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes('/auth/signin'), { timeout: 20_000 });
}

test('admin previews and sends a bulk invitation roster', { tag: '@smoke' }, async ({ page }) => {
  const adminEmail = uniqueEmail('bulk-admin');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Bulk Admin');
  const tag = `${Date.now()}`;
  const first = `bulk-one-${tag}@example.com`;
  const second = `bulk-two-${tag}@example.com`;

  try {
    await signIn(page, adminEmail, 'AdminPass123');
    await page.goto('/admin/invite/bulk');

    // Two invitable rows, one bad address, one repeat of the first row, and the
    // signed-in admin (who already has an account).
    const roster = [first, `${second},Two Person,MENTOR`, 'not-an-email', first, adminEmail].join('\n');
    await page.getByTestId('bulk-invite-input').fill(roster);
    await page.getByTestId('bulk-invite-preview-button').click();

    const preview = page.getByTestId('bulk-invite-preview');
    await expect(preview).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('bulk-invite-count-invitable')).toContainText('2');
    await expect(page.getByTestId('bulk-invite-count-skipped')).toContainText('2');
    await expect(page.getByTestId('bulk-invite-count-errors')).toContainText('1');

    await expect(page.getByTestId('bulk-invite-row-1')).toHaveAttribute('data-status', 'invite');
    await expect(page.getByTestId('bulk-invite-row-2')).toHaveAttribute('data-status', 'invite');
    await expect(page.getByTestId('bulk-invite-row-3')).toHaveAttribute('data-status', 'error');
    await expect(page.getByTestId('bulk-invite-row-4')).toHaveAttribute('data-status', 'skip');
    await expect(page.getByTestId('bulk-invite-row-5')).toHaveAttribute('data-status', 'skip');

    // Nothing was created by the dry run.
    expect(await prisma.invitationToken.count({ where: { email: { in: [first, second] } } })).toBe(0);

    await page.getByTestId('bulk-invite-send').click();
    await expect(page.getByTestId('bulk-invite-result')).toBeVisible({ timeout: 20_000 });

    // Delivery is reported honestly (#1431): every created row carries the mail
    // transport's own verdict, never "it did not throw, so it was sent". CI has
    // no SMTP, so these rows are created-but-not-emailed and must hand back the
    // registration link — GET /api/invite withholds it for an emailed address.
    const sentState = await page.getByTestId('bulk-invite-row-1').getAttribute('data-email-sent');
    expect(['true', 'false']).toContain(sentState);
    if (sentState === 'false') {
      await expect(page.getByTestId('bulk-invite-link-1')).toHaveValue(/\/auth\/register\?token=/);
    }

    // The two invitable rows became invitations, with the per-row role honoured.
    const tokens = await prisma.invitationToken.findMany({
      where: { email: { in: [first, second] } },
      select: { email: true, role: true, used: true },
    });
    expect(tokens).toHaveLength(2);
    expect(tokens.find((t) => t.email === first)?.role).toBe('MENTEE');
    expect(tokens.find((t) => t.email === second)?.role).toBe('MENTOR');
    // The admin's own address was skipped, not re-invited.
    expect(await prisma.invitationToken.count({ where: { email: adminEmail } })).toBe(0);
  } finally {
    await cleanupByEmail(first);
    await cleanupByEmail(second);
    await cleanupByEmail(adminEmail);
  }
});

test('the dry run predicts the real run exactly, and admins cannot be bulk-invited', async ({ page }) => {
  const adminEmail = uniqueEmail('bulk-api-admin');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Bulk API Admin');
  const tag = `${Date.now()}`;
  const good = [`bulk-a-${tag}@example.com`, `bulk-b-${tag}@example.com`, `bulk-c-${tag}@example.com`];

  try {
    await signIn(page, adminEmail, 'AdminPass123');

    const rows = [
      'email,fullName,role,label',
      `${good[0]},"Doe, Jane",MENTEE,Autumn cohort`,
      `${good[1]}`,
      `${good[2]},Sam Mentor,MENTOR`,
      // Never mailed, always skipped.
      `someone@demo.example.com`,
      `someone@sample.invalid`,
      // An admin seat is never granted from a paste.
      `chief-${tag}@example.com,Chief,ADMIN`,
      '',
    ].join('\r\n');

    const dry = await page.request.post('/api/admin/invite/bulk', {
      data: { rows, defaultRole: 'MENTEE', dryRun: true },
    });
    expect(dry.status()).toBe(200);
    const dryBody = await dry.json();
    expect(dryBody.dryRun).toBe(true);
    expect(dryBody.invitable).toBe(3);
    expect(dryBody.skipped).toBe(2);
    expect(dryBody.errors).toBe(1);
    expect(dryBody.rows.find((r: { reason?: string }) => r.reason === 'admin_not_allowed')).toBeTruthy();

    const real = await page.request.post('/api/admin/invite/bulk', { data: { rows, defaultRole: 'MENTEE' } });
    expect(real.status()).toBe(200);
    const realBody = await real.json();
    // THE invariant.
    expect(realBody.created).toBe(dryBody.invitable);
    // Created is not the same as delivered: the two halves must add up, and an
    // undelivered invitation carries the link the admin now has to share.
    expect(realBody.emailed + realBody.unsent).toBe(realBody.created);
    for (const row of realBody.rows as { status: string; emailSent?: boolean; registerUrl?: string }[]) {
      if (row.status !== 'invite') continue;
      expect(typeof row.emailSent).toBe('boolean');
      if (row.emailSent === false) expect(row.registerUrl).toContain('/auth/register?token=');
      else expect(row.registerUrl).toBeUndefined();
    }
    expect(await prisma.invitationToken.count({ where: { email: { in: good } } })).toBe(3);
    // The reserved domains were never turned into invitations.
    expect(
      await prisma.invitationToken.count({ where: { email: { in: ['someone@demo.example.com', 'someone@sample.invalid'] } } }),
    ).toBe(0);
  } finally {
    for (const email of good) await cleanupByEmail(email);
    await cleanupByEmail(adminEmail);
  }
});

test('a mentor cannot bulk-invite', async ({ page }) => {
  const mentorEmail = uniqueEmail('bulk-mentor');
  await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Bulk Mentor');
  try {
    await signIn(page, mentorEmail, 'MentorPass123');
    const res = await page.request.post('/api/admin/invite/bulk', {
      data: { rows: 'nope@example.com', defaultRole: 'MENTEE', dryRun: true },
    });
    expect(res.status()).toBe(403);
  } finally {
    await cleanupByEmail(mentorEmail);
  }
});
