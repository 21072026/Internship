import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, signInAsFreshUser, gotoSettled } from './helpers/auth';

// #1587 — "Who accessed my account". Impersonation has always written the audit
// rows; the account holder simply could not read them. This walks the whole
// loop: an admin enters a mentee's account with a reason, leaves again, and the
// mentee signs in and finds the visit on their own account page.
test.afterAll(async () => {
  await prisma.$disconnect();
});

test('a mentee sees who impersonated their account, when and why', async ({ page }) => {
  const adminEmail = uniqueEmail('acchist-admin');
  const menteeEmail = uniqueEmail('acchist-mentee');
  // The `$&` is not decoration: the reason is free text an admin types into a
  // window.prompt, and a string-replacement interpolation would render it back
  // as the literal "{reason}" placeholder. It must survive verbatim.
  const reason = 'Ticket 4711 $& portal shows no mentor';
  await seedUser(adminEmail, 'AdminPass123!', 'ADMIN', 'AccHist Admin');
  const mentee = await seedUser(menteeEmail, 'MenteePass123!', 'MENTEE', 'AccHist Mentee');

  try {
    await signInAndSettle(page, adminEmail, 'AdminPass123!', '/admin');

    // Nobody has ever entered the admin's own account: the reassuring empty
    // state, which must be a real sentence and not an empty list.
    await page.goto('/account');
    await expect(page.getByTestId('access-history-card')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('no-access-history')).toBeVisible();

    // Start impersonating. The reason is collected through window.prompt, which
    // Playwright dismisses (→ null) unless the dialog is answered.
    page.once('dialog', (d) => d.accept(reason));
    await page.goto('/admin/users');
    const row = page.getByTestId(`user-row-${mentee.id}`);
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.getByRole('button', { name: 'Login as' }).click();
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    // Mid-impersonation there is a start row and no stop row yet — and the
    // session is happening right now. The entry must therefore say only that no
    // end has been recorded: claiming it "ended automatically" would be false
    // for the whole 30-minute window, and claiming it is active is more than an
    // absent stop row can prove. The card stays visible during impersonation on
    // purpose — it is read-only.
    await page.goto('/account');
    const card = page.getByTestId('access-history-card');
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card.getByText('AccHist Admin', { exact: true })).toBeVisible();
    await expect(card.getByText(/no end has been recorded yet/i)).toBeVisible();
    await expect(card.getByText(/ended automatically/i)).toHaveCount(0);

    // Back to the admin's own account, which writes the matching stop row.
    await page.getByRole('button', { name: /Return to your account/ }).click();
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    // The endpoint answers for the signed-in user only. It takes no user id —
    // and a hopeful query string does not widen it: the admin still gets their
    // own (empty) history, never the mentee's.
    const idor = await page.request.get(`/api/account/impersonations?userId=${mentee.id}`);
    expect(idor.status()).toBe(200);
    expect((await idor.json()).sessions).toEqual([]);

    // Now the mentee themselves — the whole point of the feature.
    await signInAsFreshUser(page, menteeEmail, 'MenteePass123!', '/portal');
    // signInAsFreshUser only waits for the URL, not a full settle — the portal's
    // own post-login redirect can still be in flight, racing this goto (see
    // gotoSettled's doc comment in helpers/auth.ts).
    await gotoSettled(page, '/account');
    const own = page.getByTestId('access-history-card');
    await expect(own).toBeVisible({ timeout: 10_000 });
    await expect(own.getByTestId('no-access-history')).toHaveCount(0);
    await expect(own.getByText('AccHist Admin', { exact: true })).toBeVisible();
    // Verbatim, `$&` and all — not the mangled "Ticket 4711 {reason} portal…".
    await expect(own.getByText(reason, { exact: false })).toBeVisible();
    await expect(own.getByText(/\{reason\}/)).toHaveCount(0);
    // A closed session reports how long it lasted, not "ended automatically".
    await expect(own.getByText(/Lasted/)).toBeVisible();
    await expect(own.getByText(/ended automatically/i)).toHaveCount(0);

    // And the reason really is on the audit row now, not only on ActivityLog.
    const started = await prisma.auditLog.findFirst({
      where: { action: 'IMPERSONATE_START', targetId: mentee.id },
    });
    expect(started?.detail).toBe(reason);
  } finally {
    await prisma.auditLog.deleteMany({ where: { targetId: mentee.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(adminEmail);
  }
});
