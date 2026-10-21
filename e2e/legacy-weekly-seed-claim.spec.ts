import crypto from 'crypto';
import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail, setOrgFeature } from './helpers/db';
import { LEGACY_SEED_KEY, seedLegacyWeeklyReports } from '@/lib/jobs/reportSubscriptions';
import { prisma as appPrisma } from '@/lib/prisma';

// The legacy weekly-report seed claims an org ONCE (#1905). The claim used to
// lean on `@@unique([orgId, key])`; since #1619 widened it to
// `(orgId, programId, key)`, an org-level row (programId NULL) is no longer
// unique — MySQL treats NULLs as distinct — so two passes running at once (the
// hourly cron and a manual /api/cron) both "won" and every admin got two
// subscriptions, i.e. two Monday mails. Pinned here: concurrent passes seed
// one subscription per admin and leave one claim row.

test.afterAll(async () => {
  await prisma.$disconnect();
  await appPrisma.$disconnect();
});

test('concurrent seed passes claim an org once', { tag: '@smoke' }, async () => {
  const stamp = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const org = await prisma.organization.create({ data: { name: `Seed Claim ${stamp}`, slug: `seed-claim-${stamp}` } });
  const admin = uniqueEmail('seed-claim-admin');
  try {
    await seedUser(admin, 'SeedClaim123!', 'ADMIN', 'Seed Claim Admin', org.id);
    await setOrgFeature(org.id, 'ADVANCED_ANALYTICS', true);

    const results = await Promise.all(
      Array.from({ length: 4 }, () => seedLegacyWeeklyReports({ orgIds: [org.id] })),
    );

    expect(results.reduce((n, r) => n + r.orgs, 0)).toBe(1);
    expect(await prisma.reportSubscription.count({ where: { orgId: org.id } })).toBe(1);
    expect(await prisma.setting.count({ where: { orgId: org.id, key: LEGACY_SEED_KEY } })).toBe(1);
  } finally {
    await prisma.reportSubscriptionSend.deleteMany({ where: { orgId: org.id } });
    await prisma.reportSubscription.deleteMany({ where: { orgId: org.id } });
    await prisma.orgEntitlement.deleteMany({ where: { orgId: org.id } });
    await prisma.setting.deleteMany({ where: { orgId: org.id } });
    await cleanupByEmail(admin);
    await prisma.organization.deleteMany({ where: { id: org.id } });
  }
});
