import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { generateSecret, totp } from '@/lib/totp';
import { requireSecondFactor } from '@/lib/auth';
import { headerSource } from '@/lib/clientIp';

// #3770: a TOTP code is spent once (#865), also when several requests carry it
// at the same moment. Every door reads the user row first and hands
// requireSecondFactor() the `lastTotpStep` it saw, so concurrent requests all
// see the OLD floor. The step used to be written back unconditionally and all
// of them got in; now one conditional UPDATE decides, and the rest are replays.
//
// Browserless on purpose: through the sign-in form the bcrypt compare holds
// the event loop long enough that requests rarely overlap in one process. The
// race is real on the bcrypt-less doors (the step-up of #3734) and across
// replicas; here it is reproduced exactly, with one stale row for all callers.

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('the same authenticator code is accepted once by concurrent callers', { tag: '@smoke' }, async () => {
  const email = uniqueEmail('totp-race');
  await seedUser(email, 'RacePass123', 'MENTEE', 'TOTP Race');
  try {
    const row = await prisma.user.findFirstOrThrow({ where: { email }, select: { id: true, email: true, orgId: true } });
    const secret = generateSecret();
    await prisma.user.update({ where: { id: row.id }, data: { twoFactorEnabled: true, twoFactorSecret: secret, lastTotpStep: null } });

    // What each door read before the race: the floor is still empty.
    const stale = { ...row, twoFactorSecret: secret, lastTotpStep: null };
    const code = totp(secret);
    const ctx = { email: row.email.toLowerCase(), ip: '203.0.113.7', origin: headerSource({}) };

    const outcomes = await Promise.allSettled([1, 2, 3].map(() => requireSecondFactor(stale, code, ctx)));
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    for (const o of outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected')) {
      expect(String(o.reason?.message)).toMatch(/Invalid authenticator code|Too many attempts/);
    }

    // The floor moved to that code's step: the next sign-in cannot reuse it.
    const after = await prisma.user.findUniqueOrThrow({ where: { id: row.id }, select: { lastTotpStep: true } });
    expect(after.lastTotpStep).not.toBeNull();
    await expect(requireSecondFactor({ ...stale, lastTotpStep: after.lastTotpStep }, code, ctx)).rejects.toThrow(/Invalid authenticator code|Too many attempts/);
  } finally {
    await prisma.accountLockout.deleteMany({ where: { email: email.toLowerCase() } }).catch(() => {});
    await cleanupByEmail(email);
  }
});
