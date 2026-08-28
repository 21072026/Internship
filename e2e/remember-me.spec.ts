import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// The NextAuth session cookie, under either spelling (http dev vs https).
const SESSION_COOKIES = ['next-auth.session-token', '__Secure-next-auth.session-token'];
const REMEMBER_COOKIES = ['internship.remember-token', '__Secure-internship.remember-token'];

async function cookieValue(context: BrowserContext, names: string[]): Promise<string | undefined> {
  const jar = await context.cookies();
  return jar.find((c) => names.includes(c.name))?.value;
}

/**
 * Drop just the session cookie — what an expired 12h session looks like.
 *
 * Removed by name rather than "clear everything and put the rest back": a
 * re-added cookie is not necessarily host-only the way the original was, which
 * leaves two entries of the same name in the jar and makes the rotation
 * assertion below read whichever one it finds first.
 */
async function expireSession(context: BrowserContext) {
  for (const name of SESSION_COOKIES) await context.clearCookies({ name });
}

async function signIn(page: Page, email: string, pw: string, remember: boolean) {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', pw);
  const box = page.getByTestId('remember-me');
  if (remember) await box.check();
  else await box.uncheck();
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith('/auth'), { timeout: 20_000 });
  // The sign-in page lands with a full-page assign(); let it settle before the
  // caller navigates, or the next goto() races the one already in flight.
  await page.waitForLoadState('load');
}

async function sessionEmail(page: Page): Promise<string | null> {
  const s = await (await page.request.get('/api/auth/session')).json();
  return s?.user?.email ?? null;
}

// #1495 — "keep me signed in": the 12h session expires, but a trusted device
// trades its rotating cookie for a new one without a password prompt.
test('a remembered device signs itself back in after the session expires', async ({ browser }) => {
  const email = uniqueEmail('remember');
  const pw = 'RememberPass123!';
  await seedUser(email, pw, 'MENTEE', 'Remember User');

  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await signIn(page, email, pw, true);

    // Polled rather than read once: enrolment is a second request the sign-in
    // page fires before it navigates, so the Set-Cookie can land a moment after
    // the dashboard does.
    await expect
      .poll(() => cookieValue(context, REMEMBER_COOKIES), { timeout: 10_000 })
      .toBeTruthy();
    const first = await cookieValue(context, REMEMBER_COOKIES);

    await expireSession(context);
    expect(await sessionEmail(page)).toBeNull();

    // Asking for a page again is all it takes: middleware routes the request
    // through /auth/resume, which trades the device cookie for a session and
    // lands on the URL that was asked for — no sign-in form in between.
    await page.goto('/portal');
    await page.waitForURL((u) => u.pathname === '/portal', { timeout: 20_000 });
    expect(await sessionEmail(page)).toBe(email);

    // The secret must not be reusable: it rotates on every refresh.
    const second = await cookieValue(context, REMEMBER_COOKIES);
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);

    // A replay of the retired secret is treated as theft: the device is revoked.
    await context.clearCookies();
    await context.addCookies([
      { name: REMEMBER_COOKIES[0], value: first!, url: page.url() },
    ]);
    // Close the rotation grace window (30s, there so two tabs racing a refresh
    // don't knock each other out) instead of sleeping through it.
    await prisma.trustedDevice.updateMany({
      where: { user: { email } },
      data: { prevValidUntil: new Date(Date.now() - 1000) },
    });
    const replay = await page.request.post('/api/auth/remember/refresh');
    expect(replay.status()).toBe(401);

    const devices = await prisma.trustedDevice.findMany({
      where: { user: { email } },
      select: { revokedAt: true },
    });
    expect(devices).toHaveLength(1);
    expect(devices[0].revokedAt).not.toBeNull();
  } finally {
    await context.close();
    await cleanupByEmail(email);
  }
});

test('signing out gives up the remembered device', async ({ browser }) => {
  const email = uniqueEmail('remember-out');
  const pw = 'RememberPass123!';
  await seedUser(email, pw, 'MENTEE', 'Remember Signout');

  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await signIn(page, email, pw, true);
    await expect
      .poll(() => cookieValue(context, REMEMBER_COOKIES), { timeout: 10_000 })
      .toBeTruthy();

    const res = await page.request.delete('/api/auth/remember');
    expect(res.ok()).toBeTruthy();
    expect(await cookieValue(context, REMEMBER_COOKIES)).toBeFalsy();

    // And the row is revoked, not merely unreachable.
    const active = await prisma.trustedDevice.count({
      where: { user: { email }, revokedAt: null },
    });
    expect(active).toBe(0);
  } finally {
    await context.close();
    await cleanupByEmail(email);
  }
});

test('"sign out of all devices" also forgets remembered devices', async ({ browser }) => {
  const email = uniqueEmail('remember-all');
  const pw = 'RememberPass123!';
  await seedUser(email, pw, 'MENTEE', 'Remember SignOutAll');

  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await signIn(page, email, pw, true);
    await expect
      .poll(() => cookieValue(context, REMEMBER_COOKIES), { timeout: 10_000 })
      .toBeTruthy();
    const token = await cookieValue(context, REMEMBER_COOKIES);

    expect((await page.request.post('/api/account/sign-out-all')).ok()).toBeTruthy();

    // Put the device cookie back by hand: even holding the exact secret, the
    // revoked device buys nothing.
    await context.clearCookies();
    await context.addCookies([{ name: REMEMBER_COOKIES[0], value: token!, url: page.url() }]);
    const refresh = await page.request.post('/api/auth/remember/refresh');
    expect(refresh.status()).toBe(401);
  } finally {
    await context.close();
    await cleanupByEmail(email);
  }
});

test('leaving the box unticked remembers nothing', async ({ browser }) => {
  const email = uniqueEmail('remember-off');
  const pw = 'RememberPass123!';
  await seedUser(email, pw, 'MENTEE', 'Remember Off');

  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await signIn(page, email, pw, false);
    expect(await cookieValue(context, REMEMBER_COOKIES)).toBeFalsy();
    expect(await prisma.trustedDevice.count({ where: { user: { email } } })).toBe(0);

    await expireSession(context);
    await page.goto('/portal');
    // Nothing to resume from, so the app does what it always did.
    await page.waitForURL((u) => u.pathname.startsWith('/auth/signin'), { timeout: 20_000 });
    await expect(page.getByTestId('remember-me')).toBeVisible();
    expect(await sessionEmail(page)).toBeNull();
  } finally {
    await context.close();
    await cleanupByEmail(email);
  }
});

test('the account page lists the remembered device and can forget it', async ({ browser }) => {
  const email = uniqueEmail('remember-list');
  const pw = 'RememberPass123!';
  await seedUser(email, pw, 'MENTEE', 'Remember List');

  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await signIn(page, email, pw, true);

    await page.goto('/account');
    const list = page.getByTestId('trusted-devices');
    await expect(list).toBeVisible();
    // The browser it was enrolled from is marked as the current one.
    await expect(list.getByText('This device')).toBeVisible();

    await list.getByRole('button', { name: 'Forget' }).click();
    await expect(page.getByTestId('no-trusted-devices')).toBeVisible();

    // Forgetting it drops the cookie as well as the row.
    expect(await cookieValue(context, REMEMBER_COOKIES)).toBeFalsy();
    expect(await prisma.trustedDevice.count({ where: { user: { email }, revokedAt: null } })).toBe(0);
  } finally {
    await context.close();
    await cleanupByEmail(email);
  }
});

// The resume path must never swallow a deliberate visit to the sign-in page:
// people go there to sign in as somebody else, and several e2e helpers switch
// accounts without signing out first.
test('a remembered browser can still open the sign-in form on purpose', async ({ browser }) => {
  const email = uniqueEmail('remember-form');
  const pw = 'RememberPass123!';
  await seedUser(email, pw, 'MENTEE', 'Remember Form');

  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await signIn(page, email, pw, true);
    await expireSession(context);

    await page.goto('/auth/signin');
    await expect(page.getByTestId('remember-me')).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/auth/signin');
  } finally {
    await context.close();
    await cleanupByEmail(email);
  }
});
