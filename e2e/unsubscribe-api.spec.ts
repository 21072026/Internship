import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { makeUnsubscribeToken } from '../src/lib/unsubscribeToken';
import { EMAIL_GROUPS } from '../src/lib/emailGroups';

// #1290 — the unsubscribe API. Every case here runs with NO SESSION: the signed
// token in the mail footer is the only credential, and a request that needed a
// login would be an unsubscribe nobody can complete from their inbox.
//
// Direct imports via `../src/...` on purpose (the integration-spec convention in
// this repo): Playwright resolves the tsconfig paths for a static import, and a
// dynamic `await import()` does not — see the warning in e2e/email-hardening.spec.ts.

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function prefsOf(userId: string): Promise<Record<string, unknown>> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { notificationPrefs: true } });
  const raw = u?.notificationPrefs;
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

test('a footer token unsubscribes one group with no session at all', async ({ request }) => {
  const email = uniqueEmail('unsub-one');
  const user = await seedUser(email, 'UnsubPass123', 'MENTEE', 'Unsub One');
  try {
    const token = makeUnsubscribeToken(user.id, 'digests');
    const res = await request.post('/api/unsubscribe', { data: { token } });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.applied).toBe(true);
    expect(body.group).toBe('digests');
    expect(body.groups).toHaveLength(EMAIL_GROUPS.length);

    expect((await prefsOf(user.id))['email:digests']).toBe(false);

    // The audit trail: an opt-out that leaves no row cannot be proved to a
    // recipient who says they asked twice.
    const logged = await prisma.activityLog.count({
      where: { action: 'email.unsubscribe', actorId: user.id },
    });
    expect(logged).toBe(1);
  } finally {
    await prisma.activityLog.deleteMany({ where: { actorId: user.id } });
    await cleanupByEmail(email);
  }
});

test('resubscribing flips the key back and keeps the legacy in-app keys', async ({ request }) => {
  const email = uniqueEmail('unsub-merge');
  const user = await seedUser(email, 'UnsubPass123', 'MENTEE', 'Unsub Merge');
  try {
    // The same JSON column carries the eleven legacy in-app switches. If the
    // unsubscribe wrote instead of merging, this is the assertion that notices.
    await prisma.user.update({
      where: { id: user.id },
      data: { notificationPrefs: { documents: false, messages: true } },
    });

    const token = makeUnsubscribeToken(user.id, 'digests');
    await request.post('/api/unsubscribe', { data: { token } });
    const res = await request.post('/api/unsubscribe', { data: { token, action: 'resubscribe' } });
    expect(res.status()).toBe(200);
    expect((await res.json()).action).toBe('resubscribe');

    const prefs = await prefsOf(user.id);
    expect(prefs['email:digests']).toBe(true);
    expect(prefs.documents).toBe(false);
    expect(prefs.messages).toBe(true);
  } finally {
    await prisma.activityLog.deleteMany({ where: { actorId: user.id } });
    await cleanupByEmail(email);
  }
});

test("an 'all' token only switches everything off when it is told to", async ({ request }) => {
  const email = uniqueEmail('unsub-all');
  const user = await seedUser(email, 'UnsubPass123', 'MENTEE', 'Unsub All');
  try {
    const token = makeUnsubscribeToken(user.id, 'all');

    // The "manage your preferences" footer link: it shows the switches, it does
    // not throw them.
    const shown = await request.post('/api/unsubscribe', { data: { token } });
    expect(shown.status()).toBe(200);
    expect((await shown.json()).applied).toBe(false);
    expect(await prefsOf(user.id)).toEqual({});

    const applied = await request.post('/api/unsubscribe', { data: { token, action: 'unsubscribe' } });
    expect(applied.status()).toBe(200);
    expect((await applied.json()).applied).toBe(true);

    const prefs = await prefsOf(user.id);
    const nonEssential = EMAIL_GROUPS.filter((g) => !g.essential);
    for (const g of nonEssential) expect(prefs[`email:${g.id}`]).toBe(false);
    expect(Object.keys(prefs)).toHaveLength(nonEssential.length);
    // Essential mail has no key to write — a password reset is not a preference.
    expect(prefs['email:account_security']).toBeUndefined();
  } finally {
    await prisma.activityLog.deleteMany({ where: { actorId: user.id } });
    await cleanupByEmail(email);
  }
});

test('a forged token is rejected and changes nothing', async ({ request }) => {
  const emailA = uniqueEmail('unsub-forge-a');
  const emailB = uniqueEmail('unsub-forge-b');
  const victim = await seedUser(emailA, 'UnsubPass123', 'MENTEE', 'Unsub Victim');
  const attacker = await seedUser(emailB, 'UnsubPass123', 'MENTEE', 'Unsub Attacker');
  try {
    // A genuine signature, re-pointed at somebody else's account.
    const mine = makeUnsubscribeToken(attacker.id, 'digests');
    const forged = `u~${victim.id}~digests.${mine.split('.').pop()}`;

    const res = await request.post('/api/unsubscribe', { data: { token: forged } });
    expect(res.status()).toBe(400);
    expect(await prefsOf(victim.id)).toEqual({});

    // Garbage is the same clean 400, never a 500 — the page has to be able to
    // render "this link is no longer valid" rather than an error report.
    const junk = await request.post('/api/unsubscribe', { data: { token: 'not-a-token' } });
    expect(junk.status()).toBe(400);
  } finally {
    await cleanupByEmail(emailA);
    await cleanupByEmail(emailB);
  }
});

test('a token for a deleted account answers 404 gone, not 500', async ({ request }) => {
  const email = uniqueEmail('unsub-gone');
  const user = await seedUser(email, 'UnsubPass123', 'MENTEE', 'Unsub Gone');
  const token = makeUnsubscribeToken(user.id, 'digests');
  await cleanupByEmail(email);

  const res = await request.post('/api/unsubscribe', { data: { token } });
  expect(res.status()).toBe(404);
  expect((await res.json()).gone).toBe(true);
});

test('RFC 8058 one-click applies immediately and is idempotent', async ({ request }) => {
  const email = uniqueEmail('unsub-oneclick');
  const user = await seedUser(email, 'UnsubPass123', 'MENTEE', 'Unsub OneClick');
  try {
    const token = makeUnsubscribeToken(user.id, 'announcements');
    const url = `/api/unsubscribe/one-click?t=${encodeURIComponent(token)}`;

    // Exactly what Gmail sends.
    const res = await request.post(url, {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      data: 'List-Unsubscribe=One-Click',
    });
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/plain');
    expect((await res.text()).trim()).toBe('Unsubscribed');
    expect((await prefsOf(user.id))['email:announcements']).toBe(false);

    // Clients in the wild send an empty body, and a second click is a second
    // POST. Both are successes: refusing either would mean refusing a real
    // person's opt-out over a formatting detail.
    const empty = await request.post(url, {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      data: '',
    });
    expect(empty.status()).toBe(200);
    const again = await request.post(url, { data: 'List-Unsubscribe=One-Click' });
    expect(again.status()).toBe(200);
    expect((await prefsOf(user.id))['email:announcements']).toBe(false);
  } finally {
    await prisma.activityLog.deleteMany({ where: { actorId: user.id } });
    await cleanupByEmail(email);
  }
});

test('a GET of the one-click URL is inert', { tag: '@smoke' }, async ({ request }) => {
  const email = uniqueEmail('unsub-scanner');
  const user = await seedUser(email, 'UnsubPass123', 'MENTEE', 'Unsub Scanner');
  try {
    const token = makeUnsubscribeToken(user.id, 'digests');
    // Every link scanner and Safe-Links rewriter GETs the URLs in a message on
    // arrival. If this mutated, employers would unsubscribe their own staff.
    const res = await request.get(`/api/unsubscribe/one-click?t=${encodeURIComponent(token)}`, {
      maxRedirects: 0,
    });
    expect(res.status()).toBe(302);
    expect(res.headers()['location']).toContain(`/u/${encodeURIComponent(token)}`);
    expect(await prefsOf(user.id)).toEqual({});
  } finally {
    await cleanupByEmail(email);
  }
});

test('the preference centre reads every group and refuses the essential one', async ({ request }) => {
  const email = uniqueEmail('unsub-prefs');
  const user = await seedUser(email, 'UnsubPass123', 'MENTEE', 'Unsub Prefs');
  try {
    const token = makeUnsubscribeToken(user.id, 'all');

    const read = await request.get(`/api/unsubscribe/prefs?t=${encodeURIComponent(token)}`);
    expect(read.status()).toBe(200);
    const body = await read.json();
    expect(body.group).toBe('all');
    expect(body.email).toBe(email);
    expect(body.groups).toHaveLength(EMAIL_GROUPS.length);
    expect(body.groups.filter((g: { essential: boolean }) => g.essential)).toHaveLength(
      EMAIL_GROUPS.filter((g) => g.essential).length
    );
    // Default ON: silence is not consent to stop sending.
    expect(body.groups.every((g: { enabled: boolean }) => g.enabled)).toBe(true);

    const saved = await request.post('/api/unsubscribe/prefs', {
      data: { token, group: 'task_reminders', enabled: false },
    });
    expect(saved.status()).toBe(200);
    expect((await prefsOf(user.id))['email:task_reminders']).toBe(false);

    // There is nothing to toggle on sign-in and security mail, and a switch that
    // silently does nothing is worse than no switch.
    const refused = await request.post('/api/unsubscribe/prefs', {
      data: { token, group: 'account_security', enabled: false },
    });
    expect(refused.status()).toBe(400);
    expect((await prefsOf(user.id))['email:account_security']).toBeUndefined();

    const bogus = await request.post('/api/unsubscribe/prefs', {
      data: { token, group: 'not_a_group', enabled: false },
    });
    expect(bogus.status()).toBe(400);
  } finally {
    await prisma.activityLog.deleteMany({ where: { actorId: user.id } });
    await cleanupByEmail(email);
  }
});
