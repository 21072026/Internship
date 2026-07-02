import { prisma } from '@/lib/prisma';
import { getSetting } from '@/lib/settings';

// GDPR storage limitation (Art. 5(1)(e)): candidate data is kept no longer than
// necessary. We anchor retention on `consentAt` — once it is older than
// `retentionMonths`, the person is asked to re-consent; if not renewed within a
// grace period they are flagged for an admin to review and erase (no automatic
// deletion). Renewing refreshes `consentAt`.

// Days after the retention limit before a record is considered "overdue" and
// surfaced for deletion review.
export const RETENTION_GRACE_DAYS = 30;

export type RetentionStatus = 'due' | 'overdue';

export interface RetentionItem {
  userId: string;
  fullName: string;
  email: string;
  consentAt: Date | null;
  monthsSinceConsent: number | null;
  status: RetentionStatus;
  reminderSentAt: Date | null;
}

function monthsAgo(months: number): Date {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d;
}

export async function getRetentionMonths(): Promise<number> {
  return parseInt(await getSetting('retentionMonths'), 10) || 12;
}

// Candidate (mentee) accounts whose consent has passed the retention limit.
// `due` = in the re-consent reminder window; `overdue` = past the grace period,
// to be reviewed for erasure by an admin.
export async function getRetentionReview(): Promise<RetentionItem[]> {
  const months = await getRetentionMonths();
  const dueCutoff = monthsAgo(months);
  const overdueCutoff = new Date(dueCutoff.getTime() - RETENTION_GRACE_DAYS * 24 * 60 * 60 * 1000);

  const users = await prisma.user.findMany({
    where: { role: 'MENTEE', consentAt: { not: null, lt: dueCutoff } },
    select: { id: true, fullName: true, email: true, consentAt: true, retentionReminderSentAt: true },
    orderBy: { consentAt: 'asc' },
  });

  const now = Date.now();
  return users.map((u) => ({
    userId: u.id,
    fullName: u.fullName,
    email: u.email,
    consentAt: u.consentAt,
    monthsSinceConsent: u.consentAt
      ? Math.floor((now - u.consentAt.getTime()) / (30 * 24 * 60 * 60 * 1000))
      : null,
    status: u.consentAt && u.consentAt < overdueCutoff ? 'overdue' : 'due',
    reminderSentAt: u.retentionReminderSentAt,
  }));
}
