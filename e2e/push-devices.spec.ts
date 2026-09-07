import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

/**
 * The /account list of browsers holding a push subscription (#1716).
 *
 * Rows are seeded straight into the table rather than produced by subscribing a
 * real browser: a genuine subscription needs a live push service (FCM/Mozilla)
 * to issue the endpoint, which no CI runner has. What the seeded rows exercise
 * is everything that is ours — the allowlisted projection, the label derived
 * from the stored user-agent, the ordering, the per-row revoke and its
 * ownership check.
 */

test.afterAll(async () => {
  await prisma.$disconnect();
});

const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
const WINDOWS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0';

async function seedSubscription(userId: string, endpoint: string, userAgent: string | null, createdAt: Date) {
  return prisma.pushSubscription.create({
    data: {
      userId,
      endpoint,
      p256dh: 'e2e-p256dh-key',
      auth: 'e2e-auth-secret',
      userAgent,
      createdAt,
      lastSeenAt: createdAt,
    },
    select: { id: true },
  });
}

test('the account page lists push devices, marks the current one and revokes just that device', async ({ page }) => {
  const email = uniqueEmail('pushdev');
  const pw = 'PushDevPass123!';
  const user = await seedUser(email, pw, 'MENTEE', 'Push Device Owner');

  const phoneEndpoint = `https://push.e2e.local/${uniqueEmail('phone')}`;
  const laptopEndpoint = `https://push.e2e.local/${uniqueEmail('laptop')}`;
  // The laptop is the newer row, so it must sort first.
  const phone = await seedSubscription(user.id, phoneEndpoint, ANDROID_UA, new Date(Date.now() - 3 * 86_400_000));
  const laptop = await seedSubscription(user.id, laptopEndpoint, WINDOWS_UA, new Date(Date.now() - 60_000));

  // A second account's subscription: it must never appear in this user's list,
  // and this user must not be able to revoke it.
  const otherEmail = uniqueEmail('pushdev-other');
  const other = await seedUser(otherEmail, pw, 'MENTEE', 'Someone Else');
  const foreign = await seedSubscription(other.id, `https://push.e2e.local/${uniqueEmail('foreign')}`, ANDROID_UA, new Date());

  try {
    await signInAndSettle(page, email, pw, '/portal');
    await page.goto('/account');

    const list = page.getByTestId('push-devices');
    await expect(list).toBeVisible();

    // Both of this user's browsers, labelled from the stored user-agent — and
    // nobody else's.
    await expect(list.getByTestId(`push-device-${laptop.id}`)).toContainText('Edge on Windows');
    await expect(list.getByTestId(`push-device-${phone.id}`)).toContainText('Chrome on Android');
    await expect(list.getByTestId(`push-device-${foreign.id}`)).toHaveCount(0);
    // Newest first.
    const labels = await list.locator('li').allTextContents();
    expect(labels.length).toBe(2);
    expect(labels[0]).toContain('Edge on Windows');

    // The API's own contract, checked on the response rather than on the render:
    // the delivery credentials never leave the server, and the row belonging to
    // the endpoint this browser claims to hold is the one marked current.
    const payload = await page.evaluate(async (endpoint) => {
      const res = await fetch('/api/push/subscribe', { headers: { 'x-push-endpoint': endpoint } });
      return { status: res.status, body: await res.text() };
    }, phoneEndpoint);
    expect(payload.status).toBe(200);
    expect(payload.body).not.toContain('e2e-p256dh-key');
    expect(payload.body).not.toContain('e2e-auth-secret');
    expect(payload.body).not.toContain('push.e2e.local');
    const devices = JSON.parse(payload.body).devices as Array<{ id: string; current: boolean }>;
    expect(devices.find((d) => d.id === phone.id)?.current).toBe(true);
    expect(devices.find((d) => d.id === laptop.id)?.current).toBe(false);

    // Someone else's subscription id is a 404 on the route, not a silent success.
    const foreignStatus = await page.evaluate(async (id) => {
      const res = await fetch(`/api/push/subscribe?id=${id}`, { method: 'DELETE' });
      return res.status;
    }, foreign.id);
    expect(foreignStatus).toBe(404);
    expect(await prisma.pushSubscription.count({ where: { id: foreign.id } })).toBe(1);

    // Revoking one device leaves the other one subscribed.
    await list.getByTestId(`push-device-${phone.id}`).getByRole('button', { name: 'Revoke' }).click();
    await expect(list.getByTestId(`push-device-${phone.id}`)).toHaveCount(0);
    await expect(list.getByTestId(`push-device-${laptop.id}`)).toBeVisible();
    expect(await prisma.pushSubscription.count({ where: { id: phone.id } })).toBe(0);
    expect(await prisma.pushSubscription.count({ where: { id: laptop.id } })).toBe(1);

    // Revoking the last one lands on the empty state.
    await list.getByTestId(`push-device-${laptop.id}`).getByRole('button', { name: 'Revoke' }).click();
    await expect(page.getByTestId('no-push-devices')).toBeVisible();
    expect(await prisma.pushSubscription.count({ where: { userId: user.id } })).toBe(0);
  } finally {
    await cleanupByEmail(email);
    await cleanupByEmail(otherEmail);
  }
});

test('a failed refresh does not take the push device list off the screen', async ({ page }) => {
  const email = uniqueEmail('pushdev-stale');
  const pw = 'PushDevPass123!';
  const user = await seedUser(email, pw, 'MENTEE', 'Stale Refresh Owner');

  const phone = await seedSubscription(user.id, `https://push.e2e.local/${uniqueEmail('phone2')}`, ANDROID_UA, new Date(Date.now() - 3 * 86_400_000));
  const laptop = await seedSubscription(user.id, `https://push.e2e.local/${uniqueEmail('laptop2')}`, WINDOWS_UA, new Date(Date.now() - 60_000));

  try {
    await signInAndSettle(page, email, pw, '/portal');
    await page.goto('/account');

    const list = page.getByTestId('push-devices');
    await expect(list.getByTestId(`push-device-${phone.id}`)).toBeVisible();

    // From here the refresh GET fails. The DELETE still goes through, so the
    // revoke succeeds and only the reload of the list breaks — the exact shape
    // of a transient failure, and the one that used to unmount the whole
    // section and leave the remaining browser invisible and unrevocable.
    await page.route('**/api/push/subscribe', async (route) => {
      if (route.request().method() === 'GET') return route.fulfill({ status: 500, body: '{}' });
      return route.fallback();
    });

    await list.getByTestId(`push-device-${phone.id}`).getByRole('button', { name: 'Revoke' }).click();

    // The revoked row goes, everything else stays: the section, the other
    // browser and its Revoke button, plus a note that the list may be stale.
    await expect(list.getByTestId(`push-device-${phone.id}`)).toHaveCount(0);
    await expect(list.getByTestId(`push-device-${laptop.id}`)).toBeVisible();
    await expect(page.getByTestId('push-devices-stale')).toBeVisible();
    expect(await prisma.pushSubscription.count({ where: { id: phone.id } })).toBe(0);
    expect(await prisma.pushSubscription.count({ where: { id: laptop.id } })).toBe(1);

    // And the still-listed browser is genuinely revocable while the GET is down.
    await page.unroute('**/api/push/subscribe');
    await list.getByTestId(`push-device-${laptop.id}`).getByRole('button', { name: 'Revoke' }).click();
    await expect(page.getByTestId('no-push-devices')).toBeVisible();
    expect(await prisma.pushSubscription.count({ where: { userId: user.id } })).toBe(0);
  } finally {
    await cleanupByEmail(email);
  }
});

test('an anonymous caller gets nothing from the push device list', async ({ request }) => {
  const res = await request.get('/api/push/subscribe');
  expect(res.status()).toBe(401);
});
