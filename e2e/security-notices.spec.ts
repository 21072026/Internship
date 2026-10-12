import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInViaApi } from './helpers/auth';
import { EMAIL_GROUP_IDS, emailGroupPrefKey } from '@/lib/emailGroups';
import { NOTIFICATION_CATEGORIES } from '@/lib/notificationPrefs';

/**
 * Security notices (#1717): "something changed on your account" reaches the
 * owner whatever their preferences say, and a sign-in from a browser the
 * account has never used earns one too.
 *
 * Shape borrowed from e2e/email-central-enforcement.spec.ts: drive a real
 * route, then read the EmailLog row and the in-app Notification row the same
 * request produced. SMTP_USER is blank in this environment, so an attempted
 * send lands as SKIPPED "SMTP not configured" — distinguishable from a
 * suppressed one ("Unsubscribed: <group>"), which is the whole assertion: a
 * person who switched EVERY switch off is still told.
 *
 * The first test is @smoke: it is a security boundary (an opt-out must never
 * silence a disclosure), and the kind of regression that arrives in a merge
 * touching sendEmail() or the e-mail groups and passes everything else.
 */

const PW = 'SecNotice123!';
const NEW_PW = 'SecNoticeChanged456!';

/** Every switch this person could conceivably have turned off, turned off. */
const EVERYTHING_OFF = Object.fromEntries([
  ...EMAIL_GROUP_IDS.map((g) => [emailGroupPrefKey(g), false]),
  ...NOTIFICATION_CATEGORIES.map((k) => [k, false]),
]);

const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const FIREFOX_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0';

async function securityMailsTo(to: string) {
  return prisma.emailLog.findMany({
    where: { to, category: 'security' },
    orderBy: { createdAt: 'asc' },
    select: { status: true, error: true, subject: true },
  });
}

async function noticesOf(userId: string, type: string) {
  return prisma.notification.findMany({ where: { userId, type }, select: { params: true } });
}

test.afterAll(async () => {
  await prisma.$disconnect();
});

test(
  'a password change is disclosed to an owner who opted out of everything',
  { tag: '@smoke' },
  async ({ request }) => {
    const email = uniqueEmail('secnotice-pw');
    const user = await seedUser(email, PW, 'MENTEE', 'Sec Notice');
    await prisma.user.update({ where: { id: user.id }, data: { notificationPrefs: EVERYTHING_OFF } });
    try {
      expect((await signInViaApi(request, email, PW)).ok).toBe(true);

      const res = await request.put('/api/account', { data: { currentPassword: PW, newPassword: NEW_PW } });
      expect(res.status(), await res.text()).toBe(200);

      // In-app row first (the sender writes it before the mail), then the mail.
      await expect.poll(() => noticesOf(user.id, 'security.passwordChanged').then((r) => r.length), { timeout: 10_000 }).toBe(1);
      await expect.poll(() => securityMailsTo(email).then((r) => r.length), { timeout: 10_000 }).toBe(1);
      const [mail] = await securityMailsTo(email);
      // Attempted, not suppressed: the essential group ignores the opt-out.
      expect(mail.status).toBe('SKIPPED');
      expect(mail.error).toContain('SMTP not configured');
      expect(mail.error).not.toContain('Unsubscribed');
      expect(mail.subject).toMatch(/password was changed/i);
    } finally {
      await cleanupByEmail(email);
    }
  }
);

test('an e-mail change is disclosed to both the old and the new address', async ({ request }) => {
  const oldEmail = uniqueEmail('secnotice-old');
  const newEmail = uniqueEmail('secnotice-new');
  const user = await seedUser(oldEmail, PW, 'MENTEE', 'Sec Notice Mail');
  try {
    expect((await signInViaApi(request, oldEmail, PW)).ok).toBe(true);
    const res = await request.put('/api/account', { data: { currentPassword: PW, email: newEmail } });
    expect(res.status(), await res.text()).toBe(200);

    await expect.poll(() => securityMailsTo(oldEmail).then((r) => r.length), { timeout: 10_000 }).toBe(1);
    await expect.poll(() => securityMailsTo(newEmail).then((r) => r.length), { timeout: 10_000 }).toBe(1);
    for (const to of [oldEmail, newEmail]) {
      const [mail] = await securityMailsTo(to);
      expect(mail.error).toContain('SMTP not configured');
      expect(mail.subject).toMatch(/e-mail address .* was changed/i);
    }
    const [notice] = await noticesOf(user.id, 'security.emailChanged');
    expect(notice).toBeTruthy();
    expect((notice.params as { email?: string }).email).toBe(newEmail);
  } finally {
    await cleanupByEmail(oldEmail);
    await cleanupByEmail(newEmail);
  }
});

test('the first browser is the baseline; a second one earns a new-device notice, a repeat does not', async ({ playwright, baseURL }) => {
  const email = uniqueEmail('secnotice-device');
  const user = await seedUser(email, PW, 'MENTEE', 'Sec Notice Device');
  const chrome = await playwright.request.newContext({ baseURL, userAgent: CHROME_MAC });
  const firefox = await playwright.request.newContext({ baseURL, userAgent: FIREFOX_WIN });
  try {
    // Baseline: the account's first browser is remembered and mails nobody.
    expect((await signInViaApi(chrome, email, PW)).ok).toBe(true);
    expect(await prisma.signInDevice.count({ where: { userId: user.id } })).toBe(1);

    // A browser the account has never used: remembered AND disclosed.
    expect((await signInViaApi(firefox, email, PW)).ok).toBe(true);
    expect(await prisma.signInDevice.count({ where: { userId: user.id } })).toBe(2);
    await expect.poll(() => noticesOf(user.id, 'security.newDevice').then((r) => r.length), { timeout: 10_000 }).toBe(1);
    const [notice] = await noticesOf(user.id, 'security.newDevice');
    expect((notice.params as { device?: string }).device).toBe('Firefox on Windows');
    await expect.poll(() => securityMailsTo(email).then((r) => r.length), { timeout: 10_000 }).toBe(1);
    const [mail] = await securityMailsTo(email);
    expect(mail.subject).toMatch(/new sign-in/i);
    expect(mail.error).toContain('SMTP not configured');

    // The same browser again: the row is touched, nothing new is said.
    const before = await prisma.signInDevice.findFirstOrThrow({ where: { userId: user.id, label: 'Firefox on Windows' } });
    expect((await signInViaApi(firefox, email, PW)).ok).toBe(true);
    const after = await prisma.signInDevice.findFirstOrThrow({ where: { id: before.id } });
    expect(after.lastSeenAt.getTime()).toBeGreaterThan(before.lastSeenAt.getTime());
    expect(await prisma.signInDevice.count({ where: { userId: user.id } })).toBe(2);
    expect((await noticesOf(user.id, 'security.newDevice')).length).toBe(1);
    expect((await securityMailsTo(email)).length).toBe(1);
  } finally {
    await chrome.dispose();
    await firefox.dispose();
    await cleanupByEmail(email);
  }
});
