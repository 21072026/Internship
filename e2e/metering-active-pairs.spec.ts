import { test, expect } from '@playwright/test';
import { prisma, uniqueEmail } from './helpers/db';
// Static imports, not `await import()`: Playwright resolves the `@/…` alias
// when it transforms the spec's import graph, Node at runtime does not.
import { activeMatchedPairs, countAdminSeats, getUsage, currentPeriod, previousPeriod } from '../src/lib/metering';
import { runUsageRollup } from '../src/lib/jobs/usageRollup';
import { generateMeetingLink } from '../src/lib/meetingRoom';

// The billable unit and its nightly rollup, against a real database (#1750).
//
// The pure rule — the month boundary, the state allowlist, the metric
// catalogue — is pinned down without a database in scripts/test/metering.test.mjs.
// What only a database can prove is what this spec asserts:
//
//   1. TWO TENANTS, MIXED ACTIVITY, counted independently. The number is
//      per-org or it is somebody else's invoice.
//   2. The definition boundary as the query actually runs it: active-with-
//      activity in, active-but-quiet out, completed-with-activity out, and a
//      relation carrying `dormantSince` out with no special handling anywhere.
//   3. The rollup is IDEMPOTENT for a closed period — re-running it produces
//      the same number and exactly one row per (org, metric, period).
//
// Data is seeded directly (no bcrypt, no UI): the assertions are about a
// counting rule, and driving screens to produce activity rows would test the
// screens instead.

test.afterAll(async () => {
  await prisma.$disconnect();
});

const PERIOD = '2026-05'; // a closed month, well away from anything else seeded
const IN_PERIOD = new Date('2026-05-14T09:00:00Z');
const BEFORE_PERIOD = new Date('2026-04-14T09:00:00Z');

async function seedOrg(prefix: string) {
  const stamp = uniqueEmail(prefix).replace(/[^a-z0-9]/gi, '').toLowerCase();
  const org = await prisma.organization.create({
    data: { name: `Metering ${prefix} ${stamp}`, slug: `metering-${stamp}`.slice(0, 60), plan: 'FREE' },
  });
  const mentor = await prisma.user.create({
    data: { email: `metering.mentor.${stamp}@import.local`, password: '!x', role: 'MENTOR', fullName: 'Metering Mentor', skills: [], orgId: org.id },
  });
  return { org, mentor, stamp };
}

/** One relation, plus (optionally) one interaction log dated into a month. */
async function seedPair(
  orgId: string,
  mentorId: string,
  stamp: string,
  n: number,
  opts: { status?: 'ACTIVE' | 'COMPLETED'; activityAt?: Date; dormant?: boolean } = {},
) {
  const mentee = await prisma.user.create({
    data: { email: `metering.mentee.${n}.${stamp}@import.local`, password: '!x', role: 'MENTEE', fullName: `Metering Mentee ${n}`, skills: [], orgId },
  });
  const relation = await prisma.mentorshipRelation.create({
    data: {
      mentorId,
      menteeId: mentee.id,
      orgId,
      status: opts.status ?? 'ACTIVE',
      ...(opts.dormant ? { dormantSince: BEFORE_PERIOD } : {}),
    },
  });
  if (opts.activityAt) {
    await prisma.interactionLog.create({
      data: { relationId: relation.id, date: opts.activityAt, notes: 'metering fixture', type: 'Meeting' },
    });
  }
  return { mentee, relation };
}

test('two tenants are metered independently, and only pairs with activity count', async () => {
  const a = await seedOrg('org-a');
  const b = await seedOrg('org-b');

  // Org A — three that count, three that must not.
  await seedPair(a.org.id, a.mentor.id, a.stamp, 1, { activityAt: IN_PERIOD });
  await seedPair(a.org.id, a.mentor.id, a.stamp, 2, { activityAt: IN_PERIOD });
  await seedPair(a.org.id, a.mentor.id, a.stamp, 3, { activityAt: IN_PERIOD });
  // ACTIVE but silent all month: the over-billing the plan-gate count would do.
  await seedPair(a.org.id, a.mentor.id, a.stamp, 4, { activityAt: BEFORE_PERIOD });
  // COMPLETED with activity in the month: finished pairs are never billed.
  await seedPair(a.org.id, a.mentor.id, a.stamp, 5, { status: 'COMPLETED', activityAt: IN_PERIOD });
  // Dormant (stamped) and quiet — excluded by the definition itself, with no
  // dormancy branch anywhere in the meter.
  await seedPair(a.org.id, a.mentor.id, a.stamp, 6, { dormant: true });

  // Org B — one that counts, one that does not.
  await seedPair(b.org.id, b.mentor.id, b.stamp, 1, { activityAt: IN_PERIOD });
  await seedPair(b.org.id, b.mentor.id, b.stamp, 2, {});

  // Two admins in A (one deactivated) and one in B: seats are per-tenant too.
  await prisma.user.create({
    data: { email: `metering.admin.1.${a.stamp}@import.local`, password: '!x', role: 'ADMIN', fullName: 'Metering Admin', skills: [], orgId: a.org.id },
  });
  await prisma.user.create({
    data: { email: `metering.admin.2.${a.stamp}@import.local`, password: '!x', role: 'ADMIN', fullName: 'Metering Ex-Admin', skills: [], orgId: a.org.id, isActive: false },
  });
  await prisma.user.create({
    data: { email: `metering.admin.1.${b.stamp}@import.local`, password: '!x', role: 'ADMIN', fullName: 'Metering Admin B', skills: [], orgId: b.org.id },
  });

  try {
    expect(await activeMatchedPairs(a.org.id, PERIOD)).toBe(3);
    expect(await activeMatchedPairs(b.org.id, PERIOD)).toBe(1);
    // The month before is its own answer: only pair 4 was active in April, and
    // it is the pair that does NOT count in May. A period is a period.
    expect(await activeMatchedPairs(a.org.id, previousPeriod(PERIOD))).toBe(1);
    expect(await activeMatchedPairs(b.org.id, previousPeriod(PERIOD))).toBe(0);

    // Seats: active ADMINs of that org, and nothing else — no mentor, no
    // mentee, and not the deactivated admin.
    expect(await countAdminSeats(a.org.id)).toBe(1);
    expect(await countAdminSeats(b.org.id)).toBe(1);

    // ── The rollup, run twice ────────────────────────────────────────────────
    // A closed period must produce the same number on a re-run, and exactly one
    // row per (org, metric, period). Anything else double-counts an invoice.
    await runUsageRollup({ now: new Date(`${PERIOD}-20T02:40:00Z`), orgIds: [a.org.id, b.org.id] });
    const first = await getUsage(a.org.id, PERIOD);
    expect(first.ACTIVE_MATCHED_PAIRS).toBe(3);
    expect(first.ADMIN_SEATS).toBe(1);

    await runUsageRollup({ now: new Date(`${PERIOD}-21T02:40:00Z`), orgIds: [a.org.id, b.org.id] });
    const second = await getUsage(a.org.id, PERIOD);
    expect(second).toEqual(first);
    expect(await prisma.usageRollup.count({ where: { orgId: a.org.id, metric: 'ACTIVE_MATCHED_PAIRS', period: PERIOD } })).toBe(1);

    // The other tenant's row is its own number, written by the same run.
    expect((await getUsage(b.org.id, PERIOD)).ACTIVE_MATCHED_PAIRS).toBe(1);

    // The rollup covers the open month and the previous one — and only those.
    const rows = await prisma.usageRollup.findMany({
      where: { orgId: a.org.id },
      select: { period: true, metric: true },
    });
    const periods = [...new Set(rows.map((r) => r.period))].sort();
    expect(periods).toEqual([previousPeriod(PERIOD), PERIOD].sort());
    // Counters are never written by the rollup: an increment is not idempotent.
    expect(rows.some((r) => r.metric === 'VIDEO_ROOM')).toBe(false);
  } finally {
    for (const org of [a.org, b.org]) {
      await prisma.usageRollup.deleteMany({ where: { orgId: org.id } });
      await prisma.interactionLog.deleteMany({ where: { relation: { orgId: org.id } } });
      await prisma.mentorshipRelation.deleteMany({ where: { orgId: org.id } });
      await prisma.user.deleteMany({ where: { orgId: org.id } });
      await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
    }
  }
});

test('video volume is recorded at the room chokepoint, and gates nothing', async () => {
  const { org, mentor } = await seedOrg('video');

  try {
    // Same behaviour as before metering existed: a room name, on the public
    // instance in CI (no JaaS credentials configured), returned synchronously.
    const link = generateMeetingLink({ inviteeCount: 2, orgId: org.id });
    expect(link).toMatch(/^https:\/\/meet\.jit\.si\/InternshipCRM-[0-9a-f]{16}$/);

    // Both counters are written fire-and-forget (the meter must not add a round
    // trip to creating a room), so they are polled rather than awaited.
    await expect
      .poll(
        async () => {
          const usage = await getUsage(org.id, currentPeriod());
          return `${usage.VIDEO_ROOM ?? 0}/${usage.VIDEO_PARTICIPANT ?? 0}`;
        },
        { timeout: 10_000 },
      )
      .toBe('1/2');

    // A room with no resolvable tenant is still a room — unattributed usage is
    // not counted, never refused.
    expect(generateMeetingLink({ inviteeCount: 1, orgId: null })).toMatch(/^https:\/\/(meet\.jit\.si|8x8\.vc)\//);
  } finally {
    await prisma.usageRollup.deleteMany({ where: { orgId: org.id } });
    await prisma.user.delete({ where: { id: mentor.id } }).catch(() => {});
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
  }
});
