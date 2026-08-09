import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { makeEmailActionToken, EMAIL_ACTION_TTL_DAYS } from '../src/lib/emailActionToken';
// Static imports, not `await import()` inside a test: Playwright resolves the
// `@/…` path alias when it transforms the spec's import graph, but a dynamic
// import is resolved by Node at runtime, which knows nothing about tsconfig
// paths and fails with "Cannot find module '@/lib/prisma'".
import { hardDeleteUser } from '../src/lib/accountErasure';
import { pruneEmailLog, EMAIL_LOG_RETENTION_DAYS } from '../src/services/emailService';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// Risk hardening for the email work (#1205): the token TTL, the delivery log's
// retention window, and the guarantee that deriving `accountState` never leaks
// the password column it has to read.

test('an email-action token past its TTL is refused, and says so', async ({ page, request }) => {
  const mentorEmail = uniqueEmail('h-mentor');
  const menteeEmail = uniqueEmail('h-mentee');
  const mentor = await seedUser(mentorEmail, 'x', 'MENTOR', 'H Mentor');
  const mentee = await seedUser(menteeEmail, 'x', 'MENTEE', 'H Mentee');
  const relation = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id },
  });

  try {
    const msg = await prisma.message.create({
      data: { relationId: relation.id, senderId: mentor.id, channel: 'IN_APP', body: 'old' },
    });

    const dayNow = Math.floor(Date.now() / (24 * 60 * 60 * 1000));
    const stale = makeEmailActionToken(
      { kind: 'read', relationId: relation.id, userId: mentee.id },
      dayNow - (EMAIL_ACTION_TTL_DAYS + 1),
    );

    // 410 Gone, not 400: the link was genuine, it just aged out.
    const res = await request.post('/api/email-action', { data: { token: stale } });
    expect(res.status()).toBe(410);
    expect((await res.json()).expired).toBe(true);

    // …and it did nothing.
    expect(await prisma.message.count({ where: { id: msg.id, readAt: null } })).toBe(1);

    // The page explains it rather than showing the misleading "invalid link".
    await page.goto(`/m/${encodeURIComponent(stale)}`);
    await expect(page.getByTestId('email-action-error')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/90/)).toBeVisible();

    // A token minted just inside the window still works.
    const fresh = makeEmailActionToken(
      { kind: 'read', relationId: relation.id, userId: mentee.id },
      dayNow - (EMAIL_ACTION_TTL_DAYS - 1),
    );
    const ok = await request.post('/api/email-action', { data: { token: fresh } });
    expect(ok.ok()).toBeTruthy();
    expect(await prisma.message.count({ where: { id: msg.id, readAt: null } })).toBe(0);
  } finally {
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});

test('erasing an account removes its address from the delivery log', async ({ request }) => {
  const email = uniqueEmail('h-erase');
  const user = await seedUser(email, 'x', 'MENTEE', 'H Erase');
  try {
    await prisma.emailLog.create({
      data: { to: email, subject: 'Verify your email', category: 'verification', transport: 'primary', status: 'SENT' },
    });
    expect(await prisma.emailLog.count({ where: { to: email } })).toBe(1);

    await hardDeleteUser(user.id);

    // The log is keyed by address, not by a relation, so nothing cascades to it
    // — erasure has to clear it explicitly or the address outlives the account.
    expect(await prisma.emailLog.count({ where: { to: email } })).toBe(0);
  } finally {
    await cleanupByEmail(email);
    await prisma.emailLog.deleteMany({ where: { to: email } });
  }
  void request;
});

test('the delivery log is pruned past its retention window', async () => {
  const oldEmail = uniqueEmail('h-old');
  const newEmail = uniqueEmail('h-new');
  const day = 24 * 60 * 60 * 1000;

  try {
    await prisma.emailLog.create({
      data: {
        to: oldEmail,
        subject: 'ancient',
        status: 'SENT',
        createdAt: new Date(Date.now() - (EMAIL_LOG_RETENTION_DAYS + 5) * day),
      },
    });
    await prisma.emailLog.create({ data: { to: newEmail, subject: 'recent', status: 'SENT' } });

    const { deleted } = await pruneEmailLog();
    expect(deleted).toBeGreaterThanOrEqual(1);

    expect(await prisma.emailLog.count({ where: { to: oldEmail } })).toBe(0);
    // Anything inside the window is untouched — pruning must not eat the very
    // diagnostics the log exists for.
    expect(await prisma.emailLog.count({ where: { to: newEmail } })).toBe(1);
  } finally {
    await prisma.emailLog.deleteMany({ where: { to: { in: [oldEmail, newEmail] } } });
  }
});

test('no /api/users response ever carries the password column', async ({ page }) => {
  const adminEmail = uniqueEmail('h-admin');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'H Admin');
  const subject = await seedUser(uniqueEmail('h-subject'), 'SubjectPass123', 'MENTEE', 'H Subject');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    // `accountState` has to READ the password column to tell a mentor-created
    // record (no login) apart from a deactivated account, so the risk of it
    // riding along in a response is real and permanent. Assert on the bcrypt
    // prefix rather than on a key name — a rename must not silence this.
    for (const url of [
      '/api/users?view=directory&page=1&perPage=20&status=active',
      '/api/users?view=directory&page=1&perPage=20&status=archived',
      '/api/users',
      `/api/users/${subject.id}`,
    ]) {
      const res = await page.request.get(url);
      expect(res.ok(), `${url} should be readable by an admin`).toBeTruthy();
      const body = await res.text();
      expect(body, `${url} leaked a password hash`).not.toContain('$2a$');
      expect(body, `${url} leaked a password hash`).not.toContain('$2b$');
      expect(body, `${url} leaked a password field`).not.toMatch(/"password"\s*:/);
    }
  } finally {
    await cleanupByEmail(subject.email);
    await cleanupByEmail(adminEmail);
  }
});
