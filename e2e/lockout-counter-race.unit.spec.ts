import { test, expect } from '@playwright/test';
import { prisma, uniqueEmail } from './helpers/db';
import { recordFailedAttempt } from '@/lib/accountLockout';

// #3799: the durable lockout (#1541) counts EVERY failed attempt, also when
// several arrive at once. It used to read the row, add one in JS and upsert:
// concurrent failures read the same count and wrote the same +1, and when the
// row did not exist yet all but one of them failed on the unique key and were
// not counted at all. With one in-process limiter per replica, this counter is
// the only budget shared across replicas and redeploys.

const fresh = () => uniqueEmail('lock-race').toLowerCase();
const count = async (email: string, reason = 'totp') =>
  (await prisma.accountLockout.findUnique({ where: { email_reason: { email, reason } } }))?.failedCount ?? 0;

test.afterAll(async () => {
  await prisma.accountLockout.deleteMany({ where: { email: { startsWith: 'lock-race' } } });
  await prisma.$disconnect();
});

test('concurrent first failures are all counted and lock at the limit', { tag: '@smoke' }, async () => {
  const email = fresh();
  const results = await Promise.all(
    Array.from({ length: 7 }, () => recordFailedAttempt({ email, reason: 'totp', limit: 5, ip: '203.0.113.9' })),
  );
  expect(await count(email)).toBe(7);
  const row = await prisma.accountLockout.findUniqueOrThrow({ where: { email_reason: { email, reason: 'totp' } } });
  expect(row.lockedUntil?.getTime() ?? 0).toBeGreaterThan(Date.now());
  // At least the attempts that reached the limit were told it is locked.
  expect(results.filter(Boolean).length).toBeGreaterThanOrEqual(1);
});

test('concurrent failures on an existing count add up', { tag: '@smoke' }, async () => {
  const email = fresh();
  await recordFailedAttempt({ email, reason: 'password', limit: 10 });
  await Promise.all(Array.from({ length: 6 }, () => recordFailedAttempt({ email, reason: 'password', limit: 10 })));
  expect(await count(email, 'password')).toBe(7);
  const row = await prisma.accountLockout.findUniqueOrThrow({ where: { email_reason: { email, reason: 'password' } } });
  expect(row.lockedUntil).toBeNull();
});

test('a run-out window starts a fresh count once, even under concurrency', { tag: '@smoke' }, async () => {
  const email = fresh();
  await recordFailedAttempt({ email, reason: 'password', limit: 10 });
  // The window opened 20 minutes ago (the window is 15), with 9 failures in it.
  await prisma.accountLockout.update({
    where: { email_reason: { email, reason: 'password' } },
    data: { failedCount: 9, windowStart: new Date(Date.now() - 20 * 60 * 1000) },
  });
  await Promise.all(Array.from({ length: 3 }, () => recordFailedAttempt({ email, reason: 'password', limit: 10 })));
  // One attempt reset the window to 1, the other two counted on top of it.
  expect(await count(email, 'password')).toBe(3);
});
