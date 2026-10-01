import { prisma } from '@/lib/prisma';
import { getSetting } from '@/lib/settings';
import { orgWhere } from '@/lib/tenantFilter';

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

/**
 * How long after a mentorship ends the mentor (and the linked company) keep
 * read access to the mentee's CV and documents (#854).
 *
 * Product decision: a limited window rather than an immediate cut-off. Writing
 * a reference or answering a follow-up question after the internship ends is a
 * real part of the job, and revoking access the moment a mentor marks a
 * relation COMPLETED would push them to keep private copies instead. Indefinite
 * access is the thing that is not defensible — KVKK m.4 / GDPR Art. 5(1)(b)
 * purpose limitation. Rationale and the alternative considered:
 * docs/DATA_ACCESS_POLICY.md.
 */
export const POST_MENTORSHIP_ACCESS_MONTHS = 6;

/**
 * `where` fragment matching relations that still confer access: active ones,
 * plus those completed inside the window above.
 *
 * A COMPLETED relation with no `completedAt` matches nothing — the comparison
 * excludes nulls. `prisma/backfill-relation-completed-at.mjs` stamps legacy
 * rows at first deploy so they get a window rather than an abrupt cut-off.
 */
export function accessGrantingRelation() {
  return {
    OR: [
      { status: 'ACTIVE' as const },
      {
        status: 'COMPLETED' as const,
        completedAt: { gte: monthsAgo(POST_MENTORSHIP_ACCESS_MONTHS) },
      },
    ],
  };
}

// `orgId` names whose retention limit this is (#2628): the admin page and the
// reminder cron run outside any tenant scope, and each tenant sets its own.
export async function getRetentionMonths(orgId?: string): Promise<number> {
  return parseInt(await getSetting('retentionMonths', orgId), 10) || 12;
}

// Candidate (mentee) accounts whose consent has passed the retention limit.
// `due` = in the re-consent reminder window; `overdue` = past the grace period,
// to be reviewed for erasure by an admin.
//
// `orgId` is the reviewing admin's org, and it is required: the admin page
// renders outside any tenant scope, and with the middleware dormant an
// unfiltered read listed every tenant's candidates — names and e-mail
// addresses of another product's people (#2542). A NULL-org row is the default
// org's (`orgWhere`), never everybody's.
export async function getRetentionReview(orgId: string): Promise<RetentionItem[]> {
  const months = await getRetentionMonths(orgId);
  const dueCutoff = monthsAgo(months);
  const overdueCutoff = new Date(dueCutoff.getTime() - RETENTION_GRACE_DAYS * 24 * 60 * 60 * 1000);

  const users = await prisma.user.findMany({
    where: { AND: [{ role: 'MENTEE', consentAt: { not: null, lt: dueCutoff } }, await orgWhere(orgId)] },
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
