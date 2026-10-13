import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInViaApi, asHost, MARKETING_HOST } from './helpers/auth';
import { freshIp } from './helpers/rateLimit';

/**
 * The native app's push token endpoint (#2775, docs/mobile-push.md).
 *
 * No phone and no Expo here: what is ours is the boundary around the row —
 * who may write it, who may delete it, which host it is pinned to, and that the
 * token never comes back out on the /account list. Delivery through Expo is
 * unit-tested with a mocked fetch (scripts/test/expo-push.test.mjs).
 */

test.afterAll(async () => {
  await prisma.$disconnect();
});

const PW = 'NativePush123!';
const token = (label: string) => `ExponentPushToken[e2e${label.replace(/[^A-Za-z0-9]/g, '').slice(0, 40)}${Date.now()}]`;

function register(request: APIRequestContext, body: unknown, host?: string) {
  return request.post('/api/push/native', {
    headers: { ...freshIp('native-push'), ...(host ? asHost(host) : {}) },
    data: body,
  });
}

function unregister(request: APIRequestContext, tok: string, host?: string) {
  return request.delete('/api/push/native', { headers: host ? asHost(host) : {}, data: { token: tok } });
}

test('anonymous callers and malformed tokens are refused', { tag: '@smoke' }, async ({ request }) => {
  const tok = token('anon');
  expect((await register(request, { token: tok, platform: 'android' })).status()).toBe(401);
  expect((await unregister(request, tok)).status()).toBe(401);

  const email = uniqueEmail('npush-bad');
  await seedUser(email, PW, 'MENTEE', 'Bad Token');
  try {
    expect((await signInViaApi(request, email, PW)).ok).toBe(true);
    for (const bad of [
      { token: 'not-a-token', platform: 'android' },
      { token: 'https://fcm.googleapis.com/fcm/send/abc', platform: 'android' },
      { token: 'ExponentPushToken[has spaces in it]', platform: 'android' },
      { token: tok, platform: 'windows' },
      { platform: 'android' },
    ]) {
      expect((await register(request, bad)).status(), JSON.stringify(bad)).toBe(400);
    }
    expect((await unregister(request, 'nope')).status()).toBe(400);
    expect(await prisma.nativePushToken.count({ where: { user: { email } } })).toBe(0);
  } finally {
    await cleanupByEmail(email);
  }
});

test('one account cannot delete or see another account’s token', { tag: '@smoke' }, async ({ browser }) => {
  const aEmail = uniqueEmail('npush-a');
  const bEmail = uniqueEmail('npush-b');
  const a = await seedUser(aEmail, PW, 'MENTEE', 'Phone Owner');
  await seedUser(bEmail, PW, 'MENTEE', 'Someone Else');
  const aCtx = await browser.newContext();
  const bCtx = await browser.newContext();
  const tok = token('owner');
  try {
    expect((await signInViaApi(aCtx.request, aEmail, PW)).ok).toBe(true);
    expect((await signInViaApi(bCtx.request, bEmail, PW)).ok).toBe(true);

    const res = await register(aCtx.request, { token: tok, platform: 'android', appVersion: '0.1.0' });
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ registered: true });
    const row = await prisma.nativePushToken.findFirstOrThrow({ where: { token: tok } });
    expect(row.userId).toBe(a.id);
    // Pinned to the host the request arrived on, never one the body names.
    expect(row.host).toBe('localhost');

    // B knows A's token: deleting it with B's session removes nothing.
    const del = await unregister(bCtx.request, tok);
    expect(del.status()).toBe(200);
    expect((await del.json()).removed).toBe(0);
    expect(await prisma.nativePushToken.count({ where: { id: row.id } })).toBe(1);

    // Nor can B revoke it by id through the /account route.
    expect((await bCtx.request.delete(`/api/push/subscribe?id=${row.id}`)).status()).toBe(404);

    // A's own device list shows the install — and never the token.
    const listRes = await aCtx.request.get('/api/push/subscribe');
    const listText = await listRes.text();
    expect(listText).not.toContain(tok);
    const devices = JSON.parse(listText).devices as Array<{ id: string; kind: string; label: string }>;
    expect(devices).toContainEqual(expect.objectContaining({ id: row.id, kind: 'app', label: 'App on Android' }));
    const bDevices = (await (await bCtx.request.get('/api/push/subscribe')).json()).devices as Array<{ id: string }>;
    expect(bDevices.map((d) => d.id)).not.toContain(row.id);

    // A signs out on the phone: the row goes.
    expect((await (await unregister(aCtx.request, tok)).json()).removed).toBe(1);
    expect(await prisma.nativePushToken.count({ where: { token: tok } })).toBe(0);
  } finally {
    await aCtx.close();
    await bCtx.close();
    await cleanupByEmail(aEmail);
    await cleanupByEmail(bEmail);
  }
});

test('a revoked install stays revoked on refresh, and comes back only by registering', async ({ request }) => {
  const email = uniqueEmail('npush-rev');
  await seedUser(email, PW, 'MENTEE', 'Revoker');
  const tok = token('revoke');
  try {
    expect((await signInViaApi(request, email, PW)).ok).toBe(true);
    expect((await (await register(request, { token: tok, platform: 'ios' })).json()).registered).toBe(true);
    const row = await prisma.nativePushToken.findFirstOrThrow({ where: { token: tok } });

    // The launch-time refresh re-confirms a live row.
    expect((await (await register(request, { token: tok, platform: 'ios', refresh: true })).json()).registered).toBe(true);

    expect((await request.delete(`/api/push/subscribe?id=${row.id}`)).status()).toBe(200);
    // …but cannot resurrect one the person revoked on /account.
    expect((await (await register(request, { token: tok, platform: 'ios', refresh: true })).json()).registered).toBe(false);
    expect(await prisma.nativePushToken.count({ where: { token: tok } })).toBe(0);

    // A sign-in in the app registers again.
    expect((await (await register(request, { token: tok, platform: 'ios' })).json()).registered).toBe(true);

    // "Sign out of all devices" drops it with the sessions (trustedDevice.ts).
    expect((await request.post('/api/account/sign-out-all')).status()).toBe(200);
    expect(await prisma.nativePushToken.count({ where: { token: tok } })).toBe(0);
  } finally {
    await cleanupByEmail(email);
  }
});

test('one phone, two products: signing out of one keeps the other notifying', async ({ browser }) => {
  const stamp = `${Date.now()}-${Math.round(performance.now())}`;
  const org = await prisma.organization.create({ data: { name: `NPush ${stamp}`, slug: `npush-${stamp}`, vertical: 'MARKETING' } });
  const email = uniqueEmail('npush-both');
  // The same person, one account per product (docs/worlds.md).
  const internship = await seedUser(email, PW, 'MENTEE', 'Two Worlds');
  const marketing = await seedUser(email, PW, 'MENTOR', 'Two Worlds', { orgId: org.id });
  const iCtx = await browser.newContext();
  const mCtx = await browser.newContext();
  const tok = token('both');
  try {
    expect((await signInViaApi(iCtx.request, email, PW)).ok).toBe(true);
    expect((await signInViaApi(mCtx.request, email, PW, { host: MARKETING_HOST })).ok).toBe(true);

    expect((await register(iCtx.request, { token: tok, platform: 'android' })).status()).toBe(200);
    expect((await register(mCtx.request, { token: tok, platform: 'android' }, MARKETING_HOST)).status()).toBe(200);
    const rows = await prisma.nativePushToken.findMany({ where: { token: tok }, orderBy: { host: 'asc' } });
    expect(rows.map((r) => [r.host, r.userId])).toEqual([
      ['localhost', internship.id],
      [MARKETING_HOST, marketing.id],
    ]);

    // Sign out of the marketing product on the phone.
    expect((await (await unregister(mCtx.request, tok, MARKETING_HOST)).json()).removed).toBe(1);
    const left = await prisma.nativePushToken.findMany({ where: { token: tok } });
    expect(left.map((r) => r.userId)).toEqual([internship.id]);
  } finally {
    await iCtx.close();
    await mCtx.close();
    await prisma.nativePushToken.deleteMany({ where: { token: tok } }).catch(() => {});
    await cleanupByEmail(email);
    await prisma.setting.deleteMany({ where: { orgId: org.id } }).catch(() => {});
    await prisma.organization.deleteMany({ where: { id: org.id } }).catch(() => {});
  }
});
