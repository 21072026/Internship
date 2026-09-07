import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
// Static imports, not `await import()`: Playwright resolves the `@/…` alias when
// it transforms the spec's import graph, Node at runtime does not.
import { runRetentionPrune, RETAINED_ACTIVITY_ACTIONS } from '../src/lib/retentionEntries';
import { RETENTION_ACTIVITY_ACTION } from '../src/lib/retentionPrune';
import { RETAINED_NOTIFICATION_TYPES } from '../src/lib/notificationRetention';

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
// Between the two: outside a short window, comfortably inside a long one.
const middleAged = () => new Date(Date.now() - 60 * DAY);

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

    // Notification (#1646): the two rails no setting can lower, against a real
    // database. They are the half of this feature that cannot be undone — a
    // sweep that takes an unread bell, or a consent notice, has destroyed the
    // only copy — and asserting them anywhere but here would be asserting the
    // `where` clause against itself.
    //
    // `quiet` has no org, so this exercises the null scope and the global
    // window (180 days by default); 400 days is outside any of it.
    const oldReadNotif = await prisma.notification.create({
      data: { userId: quiet.id, type: 'message', text: `${marker} old read`, read: true, createdAt: ancient() },
    });
    const oldUnreadNotif = await prisma.notification.create({
      data: { userId: quiet.id, type: 'message', text: `${marker} old unread`, read: false, createdAt: ancient() },
    });
    const oldConsentNotif = await prisma.notification.create({
      data: {
        userId: quiet.id,
        type: RETAINED_NOTIFICATION_TYPES[0], // 'retention.confirm'
        text: `${marker} old consent`,
        read: true,
        createdAt: ancient(),
      },
    });
    const newReadNotif = await prisma.notification.create({
      data: { userId: quiet.id, type: 'message', text: `${marker} new read`, read: true, createdAt: recent() },
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
      ['activityLog', 'emailLog', 'job', 'notification', 'pageView', 'pushSubscription'].sort()
    );

    const gone = async (
      model: 'activityLog' | 'pageView' | 'pushSubscription' | 'job' | 'emailLog' | 'notification',
      id: string
    ) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((await (prisma[model] as any).findUnique({ where: { id } })) === null);

    // Gone: out of window and nothing says to keep them.
    expect(await gone('activityLog', oldActivity.id)).toBe(true);
    expect(await gone('pageView', oldView.id)).toBe(true);
    expect(await gone('pushSubscription', quietSub.id)).toBe(true);
    expect(await gone('job', succeeded.id)).toBe(true);
    expect(await gone('emailLog', oldMail.id)).toBe(true);
    expect(await gone('notification', oldReadNotif.id)).toBe(true);

    // Kept: inside the window.
    expect(await gone('activityLog', newActivity.id)).toBe(false);
    expect(await gone('pageView', newView.id)).toBe(false);
    expect(await gone('job', pending.id)).toBe(false);
    expect(await gone('emailLog', newMail.id)).toBe(false);
    expect(await gone('notification', newReadNotif.id)).toBe(false);

    // Kept although out of window, each for its own stated reason.
    expect(await gone('job', deadLettered.id)).toBe(false); // the operator still needs these
    expect(await gone('job', failing.id)).toBe(false); // mid-retry, or a diagnosis
    expect(await gone('pushSubscription', activeSub.id)).toBe(false); // owner is live
    expect(await gone('notification', oldUnreadNotif.id)).toBe(false); // rail 1: never an unread row
    expect(await gone('notification', oldConsentNotif.id)).toBe(false); // the subject's only copy of the ask

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
    await prisma.notification.deleteMany({ where: { userId: { in: [quiet.id, active.id] } } });
    await prisma.activityLog.deleteMany({ where: { actorId: { in: [quiet.id, active.id] } } });
    await prisma.emailLog.deleteMany({ where: { to: { contains: marker } } });
    await prisma.job.deleteMany({ where: { name: { startsWith: marker } } });
    await cleanupByEmail(quietEmail);
    await cleanupByEmail(activeEmail);
  }
});

/**
 * The notification window is PER TENANT (#1646, #1561).
 *
 * The runner resolves one window per entry and hands it down as `ctx.cutoff`.
 * That is right for the instance-wide telemetry tables and wrong for this one:
 * a notification belongs to a user, a user belongs to an org, and each org sets
 * its own number. `pruneNotifications` therefore ignores `ctx.cutoff` and
 * re-resolves the setting itself — a fact nothing outside that function can see,
 * which is exactly why it is asserted against a database rather than reasoned
 * about. Three tenants, three different answers, one run:
 *
 *   fast (30 days)  — both the 60-day and the 400-day row go
 *   slow (365 days) — the 60-day row stays, the 400-day row goes
 *   off  (0)        — nothing goes, at any age
 *
 * If the window were resolved once for the whole run, at least two of those
 * three would be wrong whichever number won.
 */
test('each organisation prunes notifications to its own window, and 0 keeps them forever', async () => {
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const marker = `e2e-notif-window-${stamp}`;
  const emails: string[] = [];
  const orgIds: string[] = [];

  const seedOrg = async (label: string, retentionDays: string) => {
    const org = await prisma.organization.create({
      data: { name: `Notif Window ${label} ${stamp}`, slug: `notif-window-${label}-${stamp}` },
    });
    orgIds.push(org.id);
    await prisma.setting.create({ data: { orgId: org.id, key: 'notificationRetentionDays', value: retentionDays } });
    const email = uniqueEmail(`notif-window-${label}`);
    emails.push(email);
    const user = await seedUser(email, 'RetPass123!', 'MENTEE', `Notif Window ${label}`);
    await prisma.user.update({ where: { id: user.id }, data: { orgId: org.id } });
    const middling = await prisma.notification.create({
      data: { userId: user.id, type: 'message', text: `${marker} ${label} 60d`, read: true, createdAt: middleAged() },
    });
    const ancientOne = await prisma.notification.create({
      data: { userId: user.id, type: 'message', text: `${marker} ${label} 400d`, read: true, createdAt: ancient() },
    });
    return { org, user, middling, ancientOne };
  };

  let fast: Awaited<ReturnType<typeof seedOrg>> | undefined;
  let slow: Awaited<ReturnType<typeof seedOrg>> | undefined;
  let off: Awaited<ReturnType<typeof seedOrg>> | undefined;

  try {
    fast = await seedOrg('fast', '30');
    slow = await seedOrg('slow', '365');
    off = await seedOrg('off', '0');

    const result = await runRetentionPrune();
    expect(result.failed).toEqual([]);

    const alive = async (id: string) => (await prisma.notification.findUnique({ where: { id } })) !== null;

    // 30 days: everything read and older than that is gone.
    expect(await alive(fast.middling.id)).toBe(false);
    expect(await alive(fast.ancientOne.id)).toBe(false);

    // 365 days: the 60-day row is well inside the window and must survive the
    // same run that removed its 60-day twin next door.
    expect(await alive(slow.middling.id)).toBe(true);
    expect(await alive(slow.ancientOne.id)).toBe(false);

    // 0 means keep forever — chosen, not fallen into.
    expect(await alive(off.middling.id)).toBe(true);
    expect(await alive(off.ancientOne.id)).toBe(true);

    // A switched-off window is reported. `deleted: 0` alone cannot tell "nobody
    // is pruning notifications here" from "there was nothing to prune", and the
    // audit row is where that question gets asked. The count is not pinned: the
    // shared database may hold other orgs that also keep forever.
    const entry = result.results.find((r) => r.key === 'notification');
    expect(entry?.note).toMatch(/^off:\d+\/\d+$/);
  } finally {
    for (const email of emails) {
      const user = await prisma.user.findUnique({ where: { email } });
      if (user) await prisma.notification.deleteMany({ where: { userId: user.id } });
      await cleanupByEmail(email);
    }
    // Users first: User.orgId has no cascade, so the organisation cannot go
    // while one of its members is still there.
    for (const orgId of orgIds) await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
  }
});
