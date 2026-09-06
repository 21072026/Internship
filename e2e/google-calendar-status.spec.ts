import { test, expect } from '@playwright/test';
import { seedUser, cleanupByEmail, uniqueEmail, prisma } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// Google Calendar integration (#417, #709): the operator-level status endpoint,
// ADMIN-only. Since #709 the e2e run does set GOOGLE_* (pointed at a local
// stub), so this asserts the SHAPE and the access rule rather than a particular
// configured/enabled value — those depend on the deployment, not on the code.
test('google calendar status is admin-only and reports config state', async ({ page }) => {
  const adminEmail = uniqueEmail('gcal-admin');
  await seedUser(adminEmail, 'GcalPass123', 'ADMIN', 'Gcal Admin');
  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'GcalPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    const res = await page.request.get('/api/admin/integrations/google/status');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(typeof body.configured).toBe('boolean');
    expect(typeof body.enabled).toBe('boolean');
    // A count, not an identity: how many people connected their own calendar.
    // Asserting a specific value here would only encode test-ordering.
    expect(typeof body.connections).toBe('number');
    // No secrets ever leak through the status endpoint.
    expect(JSON.stringify(body)).not.toContain('CLIENT_SECRET');
  } finally {
    await cleanupByEmail(adminEmail);
  }
});

test('non-admin cannot read google calendar status', async ({ page }) => {
  const menteeEmail = uniqueEmail('gcal-mentee');
  await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'Gcal Mentee');
  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', menteeEmail);
    await page.fill('input[type="password"]', 'MenteePass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.startsWith('/auth'), { timeout: 20_000 });

    expect((await page.request.get('/api/admin/integrations/google/status')).status()).toBe(401);
  } finally {
    await cleanupByEmail(menteeEmail);
  }
});

/**
 * The per-user "Connected calendars" card and its aggregate status endpoint
 * (#1993). Distinct from the two tests above: those cover the ADMIN-only
 * operator view of the integration, these cover what one signed-in person sees
 * about their OWN connection — including the case the card was built for, a
 * connection whose token has stopped working.
 */

// A connection row as the callback would have written it, except that the last
// write failed. The token columns hold deliberately recognisable strings: the
// point of the assertions below is that they never come back out.
async function seedBrokenConnection(userId: string) {
  return prisma.googleCalendarConnection.create({
    data: {
      userId,
      googleEmail: 'broken.calendar@gmail.example',
      scope: 'https://www.googleapis.com/auth/calendar.events openid email',
      accessTokenEnc: 'v1.e2e-sealed-access-token-value',
      refreshTokenEnc: 'v1.e2e-sealed-refresh-token-value',
      expiresAt: new Date(Date.now() - 60_000),
      lastSyncAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
      lastError: 'invalid_grant: Token has been expired or revoked.',
    },
  });
}

test('calendar status returns only my own connection and never a token', async ({ page }) => {
  const mineEmail = uniqueEmail('cal-status-mine');
  const otherEmail = uniqueEmail('cal-status-other');
  const mine = await seedUser(mineEmail, 'CalStatus123', 'MENTOR', 'Cal Status Mine');
  const other = await seedUser(otherEmail, 'CalStatus123', 'MENTOR', 'Cal Status Other');
  try {
    await seedBrokenConnection(mine.id);
    // A second person's connection exists at the same time — the endpoint must
    // not widen from "mine" to "everyone's" just because a second row is there.
    await prisma.googleCalendarConnection.create({
      data: {
        userId: other.id,
        googleEmail: 'someone.else@gmail.example',
        scope: 'openid email',
        accessTokenEnc: 'v1.other-persons-access-token',
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });

    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', mineEmail);
    await page.fill('input[type="password"]', 'CalStatus123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.startsWith('/auth'), { timeout: 20_000 });

    const res = await page.request.get('/api/integrations/calendar/status');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body.providers)).toBe(true);
    // Provider-shaped, not Google-shaped: one row per registry entry.
    const google = (body.providers as Record<string, unknown>[]).find((p) => p.provider === 'google');
    expect(google).toBeTruthy();
    expect(typeof google!.configured).toBe('boolean');
    expect(typeof google!.enabled).toBe('boolean');
    expect(google!.connected).toBe(true);
    expect(google!.accountEmail).toBe('broken.calendar@gmail.example');
    expect(typeof google!.lastSyncAt).toBe('string');
    expect(String(google!.lastError)).toContain('invalid_grant');

    const raw = JSON.stringify(body);
    // No token material and no other user's row, in any field.
    expect(raw).not.toContain('accessTokenEnc');
    expect(raw).not.toContain('refreshTokenEnc');
    expect(raw).not.toContain('e2e-sealed-access-token-value');
    expect(raw).not.toContain('e2e-sealed-refresh-token-value');
    expect(raw).not.toContain('other-persons-access-token');
    expect(raw).not.toContain('someone.else@gmail.example');
  } finally {
    await cleanupByEmail(otherEmail);
    await cleanupByEmail(mineEmail);
  }
});

test('calendar status is refused to a signed-out visitor', async ({ page }) => {
  expect((await page.request.get('/api/integrations/calendar/status')).status()).toBe(401);
});

test('a broken connection shows a warning and a reconnect button', async ({ page }) => {
  const email = uniqueEmail('cal-broken');
  const user = await seedUser(email, 'CalBroken123', 'MENTOR', 'Cal Broken');
  try {
    await seedBrokenConnection(user.id);

    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', 'CalBroken123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.startsWith('/auth'), { timeout: 20_000 });

    await page.goto('/account');
    const card = page.getByTestId('connected-calendars-card');
    await expect(card).toBeVisible({ timeout: 15_000 });

    // Which calendar this is, and how stale it is.
    await expect(card.getByTestId('google-calendar-connected')).toContainText('broken.calendar@gmail.example');
    await expect(card.getByTestId('google-calendar-last-sync')).not.toBeEmpty();

    // The honest part: the connection is broken and says so, with the
    // provider's own message rather than a generic shrug. Asserted on the
    // RENDERED text and on the whole sentence, not just 'invalid_grant': the
    // string passes through lib/sanitizeError on the way out, and a sanitizer
    // rule that eats the word after "Token" turns the one informative line in
    // this strip into "<redacted> been expired or revoked" — which the looser
    // assertion happily passed.
    const strip = card.getByTestId('google-calendar-error');
    await expect(strip).toBeVisible();
    await expect(strip).toContainText('invalid_grant: Token has been expired or revoked.');
    await expect(strip).not.toContainText('<redacted>');

    // Reconnect restarts consent for THIS provider only.
    const reconnect = card.getByTestId('google-calendar-reconnect');
    await expect(reconnect).toBeVisible();
    expect(await reconnect.getAttribute('href')).toBe('/api/integrations/google/connect');
  } finally {
    await cleanupByEmail(email);
  }
});

test('a healthy connection shows no warning strip', async ({ page }) => {
  const email = uniqueEmail('cal-healthy');
  const user = await seedUser(email, 'CalHealthy123', 'MENTOR', 'Cal Healthy');
  try {
    await prisma.googleCalendarConnection.create({
      data: {
        userId: user.id,
        googleEmail: 'healthy.calendar@gmail.example',
        scope: 'openid email',
        accessTokenEnc: 'v1.e2e-sealed-access-token-value',
        expiresAt: new Date(Date.now() + 3600_000),
        lastSyncAt: new Date(Date.now() - 5 * 60 * 1000),
      },
    });

    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', 'CalHealthy123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.startsWith('/auth'), { timeout: 20_000 });

    await page.goto('/account');
    const card = page.getByTestId('connected-calendars-card');
    await expect(card.getByTestId('google-calendar-connected')).toBeVisible({ timeout: 15_000 });
    await expect(card.getByTestId('google-calendar-error')).toHaveCount(0);
    // …and no "switched off" strip either: the e2e server sets
    // GOOGLE_CALENDAR_ENABLED=1, so meetings really are flowing. The two strips
    // are mutually exclusive by construction — a row may not claim both that it
    // is healthy and that nothing is reaching it.
    await expect(card.getByTestId('google-calendar-off')).toHaveCount(0);
    await expect(card.getByTestId('google-calendar-disconnect')).toBeVisible();
  } finally {
    await cleanupByEmail(email);
  }
});
