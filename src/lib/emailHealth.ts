import { prisma } from '@/lib/prisma';

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
}

export function sanitizeEmailError(error: string | null | undefined): string | null {
  if (!error) return null;
  return error.replace(/[\w.+-]+@[\w.-]+/g, '<redacted>').slice(0, 300);
}

export async function getEmailHealth(): Promise<EmailHealth> {
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [lastOk, lastFail, attempts24h] = await Promise.all([
    prisma.emailLog.findFirst({ where: { status: 'SENT' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
    prisma.emailLog.findFirst({ where: { status: 'FAILED' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true, error: true } }),
    prisma.emailLog.count({ where: { status: { in: ['SENT', 'FAILED'] }, createdAt: { gt: dayAgo } } }),
  ]);
  const failuresSinceOk = await prisma.emailLog.count({
    where: { status: 'FAILED', ...(lastOk ? { createdAt: { gt: lastOk.createdAt } } : {}) },
  });
  return {
    lastOkAt: lastOk?.createdAt.toISOString() ?? null,
    lastErrorAt: lastFail?.createdAt.toISOString() ?? null,
    lastError: sanitizeEmailError(lastFail?.error),
    failuresSinceOk,
    attempts24h,
  };
}
