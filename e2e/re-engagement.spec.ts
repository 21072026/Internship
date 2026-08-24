import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';
import { makeLeaveToken } from '../src/lib/reEngagement';

/**
 * The re-engagement pool (#834).
 *
 * The assertion that matters most is the negative one: joining the pool must
 * NOT move `consentAt`. "Write to me again" and "keep storing my data" are two
 * different permissions, and conflating them would make a feature meant to end
 * indefinite retention produce indefinite retention.
 */

const PASSWORD = 'PoolAdmin123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function grantPoolConsent(userId: string) {
  await prisma.userConsent.create({ data: { userId, type: 'RE_ENGAGEMENT_POOL', grantedAt: new Date() } });
}

test('pooling needs consent, never moves the retention clock, and one click ends it', async ({ page }) => {
  const adminEmail = uniqueEmail('pool-admin');
  const willingEmail = uniqueEmail('pool-yes');
  const unwillingEmail = uniqueEmail('pool-no');
  await seedUser(adminEmail, PASSWORD, 'ADMIN', 'Pool Admin');
  const willing = await seedUser(willingEmail, 'x', 'MENTEE', 'Pool Willing');
  const unwilling = await seedUser(unwillingEmail, 'x', 'MENTEE', 'Pool Unwilling');

  // A retention anchor set well in the past, so any accidental refresh is loud.
  const anchor = new Date('2026-01-15T00:00:00Z');
  await prisma.user.updateMany({ where: { id: { in: [willing.id, unwilling.id] } }, data: { consentAt: anchor } });
  await grantPoolConsent(willing.id);

  try {
    await signInAndSettle(page, adminEmail, PASSWORD, '/admin');

    // Without consent, pooling is refused — and the refusal names the reason so
    // the caller knows to invite the person rather than retry.
    const refused = await page.request.post('/api/re-engagement', {
      data: { userId: unwilling.id, action: 'join' },
    });
    expect(refused.status()).toBe(409);
    expect((await refused.json()).code).toBe('consent_missing');
    expect((await prisma.user.findUnique({ where: { id: unwilling.id } }))!.reEngageAt).toBeNull();

    // With consent, pooling works.
    const when = new Date(Date.now() + 30 * 24 * 3600 * 1000);
    const ok = await page.request.post('/api/re-engagement', {
      data: { userId: willing.id, action: 'join', at: when.toISOString(), note: 'September intake' },
    });
    expect(ok.ok()).toBeTruthy();

    const pooled = await prisma.user.findUnique({ where: { id: willing.id } });
    expect(pooled!.reEngageAt).not.toBeNull();
    expect(pooled!.reEngageNote).toBe('September intake');
    // THE assertion: the retention clock did not move.
    expect(pooled!.consentAt!.toISOString()).toBe(anchor.toISOString());

    // They show up in the pool list.
    const list = await (await page.request.get('/api/re-engagement')).json();
    expect((list.people as { id: string }[]).map((p) => p.id)).toContain(willing.id);

    // One click from the e-mail ends it — no session, and it revokes the
    // permission rather than only clearing this one date.
    const leave = await page.request.post('/api/re-engagement/leave', {
      data: { token: makeLeaveToken(willing.id) },
    });
    expect(leave.ok()).toBeTruthy();

    const after = await prisma.user.findUnique({ where: { id: willing.id } });
    expect(after!.reEngageAt).toBeNull();
    // Still not moved — leaving does not touch retention either.
    expect(after!.consentAt!.toISOString()).toBe(anchor.toISOString());
    const consent = await prisma.userConsent.findFirst({ where: { userId: willing.id, type: 'RE_ENGAGEMENT_POOL' } });
    expect(consent!.revokedAt).not.toBeNull();

    // A forged token is refused.
    const forged = await page.request.post('/api/re-engagement/leave', { data: { token: `${willing.id}.deadbeef` } });
    expect(forged.status()).toBe(400);
  } finally {
    await prisma.userConsent.deleteMany({ where: { userId: { in: [willing.id, unwilling.id] } } });
    await cleanupByEmail(unwillingEmail);
    await cleanupByEmail(willingEmail);
    await cleanupByEmail(adminEmail);
  }
});

test('pooled candidates leave the aging overdue list but stay counted', async ({ page }) => {
  const adminEmail = uniqueEmail('pool-aging-admin');
  const menteeEmail = uniqueEmail('pool-aging-mentee');
  const admin = await seedUser(adminEmail, PASSWORD, 'ADMIN', 'Pool Aging Admin');
  const mentee = await seedUser(menteeEmail, 'x', 'MENTEE', 'Pool Aging Mentee');
  await grantPoolConsent(mentee.id);
  const relation = await prisma.mentorshipRelation.create({
    data: {
      mentorId: admin.id, menteeId: mentee.id, status: 'ACTIVE',
      pipelineStatus: 'JOB_SEEKING_500',
      startDate: new Date(Date.now() - 200 * 24 * 3600 * 1000),
      // Long past its deadline: without the pool this is a permanent `overdue`.
      stageDeadline: new Date(Date.now() - 60 * 24 * 3600 * 1000),
    },
  });

  try {
    await signInAndSettle(page, adminEmail, PASSWORD, '/admin');

    const before = await (await page.request.get('/api/admin/analytics/aging')).json();
    expect((before.overdue as { menteeId: string }[]).map((o) => o.menteeId)).toContain(mentee.id);

    await page.request.post('/api/re-engagement', { data: { userId: mentee.id, action: 'join' } });

    const after = await (await page.request.get('/api/admin/analytics/aging')).json();
    expect((after.overdue as { menteeId: string }[]).map((o) => o.menteeId)).not.toContain(mentee.id);
    // Not hidden — counted.
    expect(after.pooledCount).toBeGreaterThan(0);
  } finally {
    await prisma.userConsent.deleteMany({ where: { userId: mentee.id } });
    await prisma.mentorshipRelation.delete({ where: { id: relation.id } }).catch(() => {});
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(adminEmail);
  }
});
