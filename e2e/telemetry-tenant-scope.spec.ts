import { test, expect } from '@playwright/test';
import { sendEmail } from '@/services/emailService';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

// Telemetry carries its tenant (#1556). A page view is the viewer's; a
// mail-ledger row is the RECIPIENT's — whichever request or job sent it. Both
// models are in TENANT_MODELS, so a row with the wrong (or no) org would be
// invisible to, or leak into, the wrong tenant once isolation is enforced.
//
// The mail half runs in-process like e2e/mail-queue.spec.ts: the spec's own
// process has no SMTP configured either, so sendEmail() writes its SKIPPED
// row — through the same recordEmail() every outcome uses.

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function orgWithUser(tag: string, role: 'ADMIN' | 'MENTEE' = 'ADMIN') {
  const stamp = `${Date.now()}-${Math.round(performance.now())}-${tag}`;
  const org = await prisma.organization.create({ data: { name: `TL ${tag} ${stamp}`, slug: `tl-${stamp}` } });
  const email = uniqueEmail(`tl-${tag}`);
  const user = await seedUser(email, 'TlPass123', role, `${tag} User`);
  await prisma.user.update({ where: { id: user.id }, data: { orgId: org.id } });
  return { org, email, user };
}

async function drop(...xs: { org: { id: string }; email: string }[]) {
  for (const x of xs) {
    await prisma.emailLog.deleteMany({ where: { to: x.email } }).catch(() => {});
    await cleanupByEmail(x.email);
    await prisma.organization.delete({ where: { id: x.org.id } }).catch(() => {});
  }
}

test('a page view is stamped with the viewer’s own org', { tag: '@smoke' }, async ({ page }) => {
  const a = await orgWithUser('PV');
  try {
    await prisma.userConsent.create({ data: { userId: a.user.id, type: 'ACTIVITY_TRACKING', grantedAt: new Date() } });
    await signInAndSettle(page, a.email, 'TlPass123', '/admin');
    const res = await page.request.post('/api/track/pageview', { data: { path: '/admin/tl-probe' } });
    expect(res.status()).toBe(204);
    const row = await prisma.pageView.findFirst({ where: { userId: a.user.id, path: '/admin/tl-probe' } });
    expect(row?.orgId).toBe(a.org.id);
  } finally {
    await drop(a);
  }
});

test('a mail-ledger row belongs to the recipient’s org, not the sender’s', { tag: '@smoke' }, async () => {
  const a = await orgWithUser('MA');
  const b = await orgWithUser('MB', 'MENTEE');
  try {
    // Known recipient, org not passed: resolved from the recipient's account.
    expect(await sendEmail({ to: b.email, subject: 'tl probe 1', html: '<p>x</p>', category: 'password-reset', userId: b.user.id })).toBe('SKIPPED');
    // An explicit org wins.
    expect(await sendEmail({ to: b.email, subject: 'tl probe 2', html: '<p>x</p>', category: 'password-reset', orgId: a.org.id })).toBe('SKIPPED');
    // An address with no account and no org: nobody's, never guessed.
    const stranger = uniqueEmail('tl-stranger');
    expect(await sendEmail({ to: stranger, subject: 'tl probe 3', html: '<p>x</p>', category: 'password-reset' })).toBe('SKIPPED');

    const rows = await prisma.emailLog.findMany({ where: { to: { in: [b.email, stranger] } }, orderBy: { createdAt: 'asc' } });
    const bySubject = Object.fromEntries(rows.map((r) => [r.subject, r.orgId]));
    expect(bySubject['tl probe 1']).toBe(b.org.id);
    expect(bySubject['tl probe 2']).toBe(a.org.id);
    expect(bySubject['tl probe 3']).toBeNull();
    await prisma.emailLog.deleteMany({ where: { to: stranger } });
  } finally {
    await drop(a, b);
  }
});
