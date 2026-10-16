import { prisma } from '@/lib/prisma';
import { sanitizeError } from '@/lib/sanitizeError';

// E-mail delivery health (#1190), DERIVED from the EmailLog ledger (#1194)
// instead of a separate last-state marker — the log is written on every
// attempt, so the two can never drift apart. Server-only.
//
// PII rule: the health surface never carries a recipient. EmailLog.error can
// echo the address (SMTP rejections often do), so error text is scrubbed of
// anything address-shaped before it leaves this module.

export interface EmailHealth {
  // Latest successful delivery, or null when none was ever recorded.
  lastOkAt: string | null;
  lastErrorAt: string | null;
  // Sanitized error class/message of the latest failure — never an address.
  lastError: string | null;
  // FAILED attempts recorded after the latest success (all-time when there
  // has never been a success). 0 means the channel looks healthy.
  failuresSinceOk: number;
  // Real attempts (SENT + FAILED) in the last 24h; SKIPPED rows are an
  // unconfigured-SMTP marker, not an attempt.
  attempts24h: number;
  // Mails put back to be retried in the last 24h (a relay throttle, a timeout,
  // a temporary refusal) — #2941. Deliberately NOT a failure: failuresSinceOk
  // counts FAILED only, so a throttled burst that is later delivered never
  // trips the delivery alert. Always 0 until the mail outbox writes the status.
  deferred24h: number;
  // DEFERRED rows after the latest success, and when the first of them was
  // written (#2944). A relay outage writes only these — the outbox keeps the
  // mail — so they are how an outage reaches the alert: many deferrals and no
  // delivery for long enough is an outage, a short throttle is not.
  deferredSinceOk: number;
  firstDeferredSinceOkAt: string | null;
}

// Kept as an alias: the address rule this used to own now lives in the shared
// sanitizer, which every connector's error text goes through (#2008).
export const sanitizeEmailError = sanitizeError;

export async function getEmailHealth(): Promise<EmailHealth> {
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [lastOk, lastFail, attempts24h, deferred24h] = await Promise.all([
    prisma.emailLog.findFirst({ where: { status: 'SENT' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
    prisma.emailLog.findFirst({ where: { status: 'FAILED' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true, error: true } }),
    prisma.emailLog.count({ where: { status: { in: ['SENT', 'FAILED'] }, createdAt: { gt: dayAgo } } }),
    prisma.emailLog.count({ where: { status: 'DEFERRED', createdAt: { gt: dayAgo } } }),
  ]);
  const sinceOk = lastOk ? { createdAt: { gt: lastOk.createdAt } } : {};
  const [failuresSinceOk, deferredSinceOk, firstDeferred] = await Promise.all([
    prisma.emailLog.count({ where: { status: 'FAILED', ...sinceOk } }),
    prisma.emailLog.count({ where: { status: 'DEFERRED', ...sinceOk } }),
    prisma.emailLog.findFirst({
      where: { status: 'DEFERRED', ...sinceOk },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    }),
  ]);
  return {
    lastOkAt: lastOk?.createdAt.toISOString() ?? null,
    lastErrorAt: lastFail?.createdAt.toISOString() ?? null,
    lastError: sanitizeError(lastFail?.error),
    failuresSinceOk,
    attempts24h,
    deferred24h,
    deferredSinceOk,
    firstDeferredSinceOkAt: firstDeferred?.createdAt.toISOString() ?? null,
  };
}
