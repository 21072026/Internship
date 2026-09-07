import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
// Static imports, not `await import()`: Playwright resolves the `@/…` alias when
// it transforms the spec's import graph, Node at runtime does not.
import { runRetentionPrune, RETAINED_ACTIVITY_ACTIONS } from '../src/lib/retentionEntries';
import { RETENTION_ACTIVITY_ACTION } from '../src/lib/retentionPrune';

// The daily retention sweep (#1678), against a real database.
//
// The claim under test is the only one that matters and the easiest to get
// backwards: OLD ROWS GO AND NEW ROWS STAY. A prune that takes too much is
// unrecoverable — these tables have no undo — and a prune that takes nothing is
// the status quo it was written to end.
//
// Everything is seeded well outside every window (400 days) or well inside it
// (one day), so the assertions do not depend on the configured numbers; the
// windows themselves are asserted where they are decided, in
// src/lib/retentionEntries.ts.
//
// Counts are asserted per seeded row rather than against the run's totals: this
// spec runs on a shared database, and the sweep legitimately removes other
// out-of-window rows in the same pass. That is the job doing its job.

const DAY = 24 * 60 * 60 * 1000;
const ancient = () => new Date(Date.now() - 400 * DAY);
const recent = () => new Date(Date.now() - DAY);

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('old telemetry rows are pruned and recent ones survive', async () => {
  const quietEmail = uniqueEmail('ret-quiet');
  const activeEmail = uniqueEmail('ret-active');
  const marker = `e2e-retention-${Date.now()}`;

  const quiet = await seedUser(quietEmail, 'RetPass123!', 'MENTEE', 'Retention Quiet');
  const active = await seedUser(activeEmail, 'RetPass123!', 'MENTEE', 'Retention Active');

  try {
    // An account nobody has seen for over a year, and one signed in today. The
    // difference decides whether their stale push subscription is dead weight
    // or a live user who simply gets no notifications.
    await prisma.user.update({
      where: { id: quiet.id },
      data: { lastSeenAt: ancient(), lastLoginAt: ancient() },
    });
    await prisma.user.update({
      where: { id: active.id },
      data: { lastSeenAt: new Date(), lastLoginAt: new Date() },
    });

    // ActivityLog: an ordinary old row, an old EVIDENCE row carrying network
    // identifiers, and a fresh row.
    const oldActivity = await prisma.activityLog.create({
      data: { action: `${marker}.old`, actorId: quiet.id, createdAt: ancient(), ip: '203.0.113.9', userAgent: 'e2e' },
    });
    const oldEvidence = await prisma.activityLog.create({
      data: {
        action: RETAINED_ACTIVITY_ACTIONS[0], // 'email.unsubscribe'
        actorId: quiet.id,
        detail: marker,
        createdAt: ancient(),
        ip: '203.0.113.9',
        userAgent: 'e2e',
      },
    });
    const newActivity = await prisma.activityLog.create({
      data: { action: `${marker}.new`, actorId: quiet.id, createdAt: recent(), ip: '203.0.113.9' },
    });

    // PageView: browsing history either side of the window.
    const oldView = await prisma.pageView.create({
      data: { userId: quiet.id, path: `/${marker}/old`, createdAt: ancient() },
    });
    const newView = await prisma.pageView.create({
      data: { userId: quiet.id, path: `/${marker}/new`, createdAt: recent() },
    });

    // PushSubscription: same staleness, different owners.
    const quietSub = await prisma.pushSubscription.create({
      data: {
        userId: quiet.id,
        endpoint: `https://push.example.com/${marker}-quiet`,
        p256dh: 'k',
        auth: 'a',
        lastSeenAt: ancient(),
      },
    });
    const activeSub = await prisma.pushSubscription.create({
      data: {
        userId: active.id,
        endpoint: `https://push.example.com/${marker}-active`,
        p256dh: 'k',
        auth: 'a',
        lastSeenAt: ancient(),
      },
    });

    // Queue rows: only the terminal-and-uninteresting ones may go.
    const succeeded = await prisma.job.create({
      data: { name: `${marker}-ok`, payload: {}, status: 'SUCCEEDED', createdAt: ancient(), updatedAt: ancient() },
    });
    const deadLettered = await prisma.job.create({
      data: { name: `${marker}-dlq`, payload: {}, status: 'DEAD_LETTER', createdAt: ancient(), updatedAt: ancient() },
    });
    const failing = await prisma.job.create({
      data: { name: `${marker}-failed`, payload: {}, status: 'FAILED', createdAt: ancient(), updatedAt: ancient() },
    });
    const pending = await prisma.job.create({
      data: { name: `${marker}-pending`, payload: {}, status: 'PENDING' },
    });

    // EmailLog: the prune that moved here, still doing what it did.
    const oldMail = await prisma.emailLog.create({
      data: { to: `old-${marker}@e2e.local`, subject: 'ancient', status: 'SENT', createdAt: ancient() },
    });
    const newMail = await prisma.emailLog.create({
      data: { to: `new-${marker}@e2e.local`, subject: 'recent', status: 'SENT' },
    });

    const result = await runRetentionPrune();

    // No entry may fail: a failure here is a broken query, not a clean table.
    expect(result.failed).toEqual([]);
    expect(result.results.map((r) => r.key).sort()).toEqual(
      ['activityLog', 'emailLog', 'job', 'pageView', 'pushSubscription'].sort()
    );

    const gone = async (model: 'activityLog' | 'pageView' | 'pushSubscription' | 'job' | 'emailLog', id: string) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((await (prisma[model] as any).findUnique({ where: { id } })) === null);

    // Gone: out of window and nothing says to keep them.
    expect(await gone('activityLog', oldActivity.id)).toBe(true);
    expect(await gone('pageView', oldView.id)).toBe(true);
    expect(await gone('pushSubscription', quietSub.id)).toBe(true);
    expect(await gone('job', succeeded.id)).toBe(true);
    expect(await gone('emailLog', oldMail.id)).toBe(true);

    // Kept: inside the window.
    expect(await gone('activityLog', newActivity.id)).toBe(false);
    expect(await gone('pageView', newView.id)).toBe(false);
    expect(await gone('job', pending.id)).toBe(false);
    expect(await gone('emailLog', newMail.id)).toBe(false);

    // Kept although out of window, each for its own stated reason.
    expect(await gone('job', deadLettered.id)).toBe(false); // the operator still needs these
    expect(await gone('job', failing.id)).toBe(false); // mid-retry, or a diagnosis
    expect(await gone('pushSubscription', activeSub.id)).toBe(false); // owner is live

    // The evidence row survives, stripped of the two columns that made it
    // personal data rather than a fact about the account.
    const evidence = await prisma.activityLog.findUnique({ where: { id: oldEvidence.id } });
    expect(evidence).not.toBeNull();
    expect(evidence?.ip).toBeNull();
    expect(evidence?.userAgent).toBeNull();
    expect(evidence?.detail).toBe(marker);

    // One receipt per run, carrying the per-table counts, and short enough for
    // the VARCHAR(191) column it lives in.
    const receipt = await prisma.activityLog.findFirst({
      where: { action: RETENTION_ACTIVITY_ACTION },
      orderBy: { createdAt: 'desc' },
    });
    expect(receipt).not.toBeNull();
    expect(receipt!.detail || '').not.toBe('');
    expect((receipt!.detail || '').length).toBeLessThanOrEqual(191);
    expect(receipt!.detail).toContain('activityLog=');
  } finally {
    await prisma.activityLog.deleteMany({ where: { actorId: { in: [quiet.id, active.id] } } });
    await prisma.emailLog.deleteMany({ where: { to: { contains: marker } } });
    await prisma.job.deleteMany({ where: { name: { startsWith: marker } } });
    await cleanupByEmail(quietEmail);
    await cleanupByEmail(activeEmail);
  }
});
