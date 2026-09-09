import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { notifyEvent } from '@/lib/notifications/router';

/**
 * The notification router, end to end against a real database (#1710).
 *
 * scripts/test/notification-catalog.test.mjs pins the catalogue against the
 * dictionary, and src/lib/notifications/typeContract.ts pins the types. Neither
 * can see the part that only exists at runtime: whether one call actually
 * produces one in-app row, one queued e-mail job and one ledger row per
 * channel — and, the half that matters most, whether an opt-out is read BEFORE
 * the send identity is claimed.
 *
 * That ordering is not a style question. docs/agent-experience.md records the
 * dormant-first-contact sweep making the opposite mistake: it stamped its "we
 * contacted them" counter first and read the opt-out second, so every opted-out
 * person spent one of their two allowed mails on a message that was never sent.
 * The third test below is that ordering, asserted: a suppressed delivery lands
 * as SKIPPED with its reason and does NOT consume the dedupe identity, so if
 * the person turns the category back on the same send still goes out.
 *
 * Shape borrowed from e2e/email-central-enforcement.spec.ts: no browser, no
 * route — call the server module directly and read the rows the call wrote. The
 * ledger IS the observable, which is the entire point of it existing.
 *
 * Not tagged @smoke: the PR gate's smoke subset is deliberately small, and no
 * send site is routed through notifyEvent() yet, so nothing a user can click
 * regresses when this breaks.
 */

const PW = 'NotifyRouter123!';

async function ledgerFor(userId: string) {
  return prisma.notificationDelivery.findMany({
    where: { userId },
    orderBy: [{ channel: 'asc' }],
    select: { channel: true, status: true, skipReason: true, eventKey: true, templateId: true },
  });
}

/**
 * The queued mail jobs belonging to one recipient. Filtered in JS rather than
 * with a JSON-path `where`: the payload shape is this module's own contract,
 * and a portable filter matters more here than one fewer row read in a test.
 */
async function mailJobsFor(userId: string) {
  const jobs = await prisma.job.findMany({
    where: { name: 'notification.email' },
    select: { id: true, payload: true, idempotencyKey: true },
  });
  return jobs.filter((j) => (j.payload as { userId?: string } | null)?.userId === userId);
}

async function cleanup(email: string) {
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (user) {
    // Neither the ledger nor the queue has an FK to User (both are ledgers on
    // purpose), so cleanupByEmail cannot reach them.
    await prisma.notificationDelivery.deleteMany({ where: { userId: user.id } });
    const jobs = await mailJobsFor(user.id);
    if (jobs.length > 0) {
      await prisma.job.deleteMany({ where: { id: { in: jobs.map((j) => j.id) } } });
    }
    await prisma.notification.deleteMany({ where: { userId: user.id } });
  }
  await cleanupByEmail(email);
}

test.describe('notification router', () => {
  test('one call produces an in-app row, a queued e-mail job and one ledger row per channel', async () => {
    const email = uniqueEmail('notify-router');
    const user = await seedUser(email, PW, 'MENTOR', 'Notify Router');
    try {
      const result = await notifyEvent(user.id, 'deadline.stagePassed', {
        menteeName: 'Aylin',
        relationId: 'rel-1',
      });

      // 'deadline.stagePassed' defaults to both channels.
      expect(result).toMatchObject({ sent: 1, queued: 1, skipped: 0, failed: 0, deduped: 0 });

      // The in-app row is written through the existing notify(), so it carries
      // the event key as `type` and the params the dictionary interpolates —
      // unchanged, which is what makes the router a wrapper and not a rewrite.
      const inApp = await prisma.notification.findFirst({
        where: { userId: user.id },
        select: { type: true, params: true, link: true },
      });
      expect(inApp?.type).toBe('deadline.stagePassed');
      expect(inApp?.params).toMatchObject({ menteeName: 'Aylin' });
      // The link is built by notificationLink() for the recipient's ROLE, not
      // by the caller: a mentor's deadline row points at their own mentee page.
      expect(inApp?.link).toBe('/mentor/mentees/rel-1');

      // The e-mail is enqueued, never sent inline — a dead SMTP server must not
      // sit inside the request that triggered the notification.
      const jobs = await mailJobsFor(user.id);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].payload).toMatchObject({ eventKey: 'deadline.stagePassed', locale: 'en' });
      expect(jobs[0].idempotencyKey?.startsWith('notify:')).toBe(true);

      const ledger = await ledgerFor(user.id);
      expect(ledger).toHaveLength(2);
      expect(ledger.find((r) => r.channel === 'email')).toMatchObject({
        status: 'QUEUED',
        eventKey: 'deadline.stagePassed',
      });
      expect(ledger.find((r) => r.channel === 'inApp')).toMatchObject({
        status: 'SENT',
        eventKey: 'deadline.stagePassed',
        templateId: 'notifications.events.deadline.stagePassed',
      });
    } finally {
      await cleanup(email);
    }
  });

  test('a repeated send with the same dedupe key neither duplicates a row nor sends twice', async () => {
    const email = uniqueEmail('notify-dedupe');
    const user = await seedUser(email, PW, 'MENTOR', 'Notify Dedupe');
    try {
      const payload = { menteeName: 'Aylin', relationId: 'rel-1' };
      const first = await notifyEvent(user.id, 'deadline.stagePassed', payload, {
        dedupeKey: 'relation-1-2026-09-07',
        channels: ['inApp'],
      });
      const second = await notifyEvent(user.id, 'deadline.stagePassed', payload, {
        dedupeKey: 'relation-1-2026-09-07',
        channels: ['inApp'],
      });

      expect(first).toMatchObject({ sent: 1, deduped: 0 });
      // The retry is recognised, not re-sent: the second call claims nothing.
      expect(second).toMatchObject({ sent: 0, deduped: 1 });

      expect(await prisma.notificationDelivery.count({ where: { userId: user.id } })).toBe(1);
      expect(await prisma.notification.count({ where: { userId: user.id } })).toBe(1);
    } finally {
      await cleanup(email);
    }
  });

  test('an opted-out category is recorded as SKIPPED and does not claim the send', async () => {
    const email = uniqueEmail('notify-optout');
    const user = await seedUser(email, PW, 'MENTOR', 'Notify Optout');
    try {
      // The legacy in-app category switch on /account (#886). It gates BOTH
      // channels for this event, so the whole notification is suppressed.
      await prisma.user.update({
        where: { id: user.id },
        data: { notificationPrefs: { deadlines: false } },
      });

      const suppressed = await notifyEvent(
        user.id,
        'deadline.stagePassed',
        { menteeName: 'Aylin', relationId: 'rel-1' },
        { dedupeKey: 'relation-1-2026-09-07' }
      );

      expect(suppressed).toMatchObject({ sent: 0, queued: 0, skipped: 2, failed: 0 });
      expect(await prisma.notification.count({ where: { userId: user.id } })).toBe(0);
      expect(await mailJobsFor(user.id)).toHaveLength(0);

      const ledger = await ledgerFor(user.id);
      expect(ledger).toHaveLength(2);
      for (const row of ledger) {
        expect(row.status).toBe('SKIPPED');
        expect(row.skipReason).toBe('category_off');
      }

      // THE POINT: the suppressed attempt did not burn the identity. Turn the
      // category back on and the same call — same dedupe key — still delivers.
      await prisma.user.update({ where: { id: user.id }, data: { notificationPrefs: {} } });
      await prisma.notificationDelivery.deleteMany({ where: { userId: user.id } });

      const delivered = await notifyEvent(
        user.id,
        'deadline.stagePassed',
        { menteeName: 'Aylin', relationId: 'rel-1' },
        { dedupeKey: 'relation-1-2026-09-07', channels: ['inApp'] }
      );
      expect(delivered).toMatchObject({ sent: 1, skipped: 0 });
      expect(await prisma.notification.count({ where: { userId: user.id } })).toBe(1);
    } finally {
      await cleanup(email);
    }
  });

  test('a security disclosure ignores every switch', async () => {
    const email = uniqueEmail('notify-mandatory');
    const user = await seedUser(email, PW, 'MENTEE', 'Notify Mandatory');
    try {
      // Everything off: the master e-mail switch, the category, and the e-mail
      // group. `impersonation.accessed` sits in the essential account_security
      // group, so it is delivered anyway — telling somebody an administrator
      // entered their account is a disclosure, not a preference.
      await prisma.user.update({
        where: { id: user.id },
        data: {
          emailNotifications: false,
          notificationPrefs: { announcements: false, 'email:account_security': false },
        },
      });

      const result = await notifyEvent(user.id, 'impersonation.accessed', {});
      expect(result).toMatchObject({ sent: 1, queued: 1, skipped: 0, failed: 0 });
      expect(await prisma.notification.count({ where: { userId: user.id } })).toBe(1);
      expect(await mailJobsFor(user.id)).toHaveLength(1);
    } finally {
      await cleanup(email);
    }
  });

  test('a recipient with no address gets the in-app row and no mail, and nothing throws', async () => {
    // The contract every existing call site depends on: notify() has always
    // swallowed its own failures so a notification cannot break the action that
    // triggered it, and the router keeps that promise. An id that resolves to no
    // user is the degenerate case — it has no address, so the e-mail channel is
    // recorded as skipped for the honest reason rather than attempted.
    const orphanId = `notify-orphan-${Date.now()}`;
    try {
      const result = await notifyEvent(orphanId, 'evaluation.added', {});
      expect(result.queued).toBe(0);
      expect(result.failed).toBe(0);
      const ledger = await ledgerFor(orphanId);
      expect(ledger.find((r) => r.channel === 'email')).toMatchObject({
        status: 'SKIPPED',
        skipReason: 'no_address',
      });
    } finally {
      await prisma.notificationDelivery.deleteMany({ where: { userId: orphanId } });
    }
  });
});
