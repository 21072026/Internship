import { test, expect } from '@playwright/test';
import crypto from 'crypto';
import { prisma, cleanupByEmail, uniqueEmail } from './helpers/db';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #2071 — the invitation status board: filter, bulk re-invite, revoke.
//
// The board filters by `orgId` explicitly (InvitationToken is NOT in
// TENANT_MODELS, so nothing scopes it centrally), which is why the fixtures
// below are created with the signed-in admin's own orgId rather than through
// the seedInvite helper — an org-less row is correctly invisible there.
async function seedBoardInvite(
  email: string,
  orgId: string | null,
  overrides: Record<string, unknown> = {},
) {
  const token = crypto.randomBytes(32).toString('hex');
  const row = await prisma.invitationToken.create({
    data: {
      token,
      email,
      role: 'MENTEE',
      orgId,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      ...overrides,
    },
  });
  return { id: row.id, token };
}

test('invitation board filters, bulk re-invites and revokes', async ({ page }) => {
  // One shared prefix so the free-text filter can isolate this run's fixtures
  // from whatever else the environment's database already holds.
  const prefix = `board-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const staleEmail = `${prefix}-stale@e2e.local`;
  const joinedEmail = `${prefix}-joined@e2e.local`;
  const otherEmail = uniqueEmail('board-other');

  const admin = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL }, select: { orgId: true } });
  const orgId = admin?.orgId ?? null;

  // Expired and never opened → re-invitable.
  const stale = await seedBoardInvite(staleEmail, orgId, {
    expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
  });
  // Already registered → the board must refuse to re-invite it.
  const joinedExpiresAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  const joined = await seedBoardInvite(joinedEmail, orgId, {
    used: true,
    registeredAt: new Date(),
    expiresAt: joinedExpiresAt,
  });
  // Outside the search filter — proves the filter narrows rather than decorates.
  const other = await seedBoardInvite(otherEmail, orgId);

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', ADMIN_EMAIL);
    await page.fill('input[type="password"]', ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.includes('/auth/signin'), { timeout: 20_000 });

    await page.goto('/admin/invitations');

    // The page-level search box carries its own testid: AdminNav renders an
    // input[type="search"] on every admin page, so a bare selector would type
    // into the sidebar filter instead.
    await page.getByTestId('invitations-search').fill(prefix);

    const table = page.getByTestId('invitations-table');
    await expect(table.getByTestId(`invitation-row-${stale.id}`)).toBeVisible({ timeout: 15_000 });
    await expect(table.getByTestId(`invitation-row-${joined.id}`)).toBeVisible();
    await expect(table.getByTestId(`invitation-row-${other.id}`)).toHaveCount(0);

    // Derived status, straight from the shared helper on the server.
    await expect(page.getByTestId(`invitation-status-${stale.id}`)).toHaveText(/expired|süresi|abgelaufen/i);
    await expect(page.getByTestId(`invitation-status-${joined.id}`)).toHaveText(/registered|kayıt|registriert/i);

    // Bulk re-invite both: the stale one is refreshed, the registered one is
    // skipped — and the result panel has to say so per row.
    await page.getByTestId('invitations-select-all').check();
    await page.getByTestId('invitations-resend').click();
    await page.getByTestId('confirm-dialog-confirm').click();

    const result = page.getByTestId('invitations-result');
    await expect(result).toBeVisible({ timeout: 20_000 });
    await expect(result).toContainText(staleEmail);
    await expect(result).toContainText(joinedEmail);

    const staleAfter = await prisma.invitationToken.findUnique({ where: { id: stale.id } });
    expect(staleAfter!.expiresAt.getTime()).toBeGreaterThan(Date.now());
    const joinedAfter = await prisma.invitationToken.findUnique({ where: { id: joined.id } });
    expect(joinedAfter!.used).toBe(true);
    // Untouched: a row that already registered is skipped, not merely unmailed.
    expect(joinedAfter!.expiresAt.getTime()).toBe(joinedExpiresAt.getTime());

    // Status filter narrows the table to one row.
    await page.getByTestId('invitations-status').selectOption('registered');
    await expect(table.getByTestId(`invitation-row-${joined.id}`)).toBeVisible();
    await expect(table.getByTestId(`invitation-row-${stale.id}`)).toHaveCount(0);
    await page.getByTestId('invitations-status').selectOption('');

    // Revoking is a real state, not a hide: the token stops being redeemable.
    await page.getByTestId(`invitation-select-${stale.id}`).check();
    await page.getByTestId('invitations-revoke').click();
    await page.getByTestId('confirm-dialog-confirm').click();
    await expect(page.getByTestId(`invitation-status-${stale.id}`)).toHaveText(
      /revoked|iptal|widerrufen/i,
      { timeout: 20_000 },
    );

    const registerAttempt = await page.request.post('/api/register', {
      data: {
        token: stale.token,
        email: staleEmail,
        password: 'Passw0rd!23',
        fullName: 'Revoked Invitee',
        consent: true,
      },
    });
    expect(registerAttempt.status()).toBe(400);
  } finally {
    await prisma.invitationToken.deleteMany({
      where: { id: { in: [stale.id, joined.id, other.id] } },
    });
    await cleanupByEmail(staleEmail);
    await cleanupByEmail(joinedEmail);
    await cleanupByEmail(otherEmail);
  }
});
