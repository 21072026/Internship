// Shared by the admin report-subscription routes (#1905): who may manage them,
// and the write-time checks a subscription must pass before it is stored.
import type { Session } from 'next-auth';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { entitled } from '@/lib/entitlements';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { inCallerTenant } from '@/lib/tenantFilter';
import { shellCapabilities } from '@/lib/shellCapabilities';
import { getReportDefinition } from '@/lib/reports/definitions';
import { subscriptionProblem, type SubscriptionInput } from '@/lib/reportSubscriptions';

const locked = (feature: string) =>
  NextResponse.json({ error: 'feature_locked', code: 'feature_locked', feature }, { status: 403 });

/**
 * The caller's org when they may manage subscriptions, else the response to
 * return. ADMIN, and the org's ADVANCED_ANALYTICS — the reports themselves are
 * premium, so subscribing to one is too.
 */
export async function subscriptionAdminOrg(session: Session | null): Promise<{ orgId: string } | { response: NextResponse }> {
  if (!session || session.user.role !== 'ADMIN') return { response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  const orgId = await settingsOrgOf(session);
  if (!(await entitled(orgId, 'ADVANCED_ANALYTICS'))) return { response: locked('ADVANCED_ANALYTICS') };
  return { orgId };
}

/**
 * Everything that must hold before a subscription is written, or the 4xx to
 * answer with. An unknown report, a report this org's vertical does not carry,
 * a file format without REPORT_EXPORT and a recipient from another tenant are
 * all refused HERE — never discovered by the job with nobody watching.
 */
export async function subscriptionWriteProblem(orgId: string, input: SubscriptionInput): Promise<NextResponse | null> {
  const problem = subscriptionProblem(input);
  if (problem) return NextResponse.json({ error: problem, code: problem }, { status: 400 });
  const def = getReportDefinition(input.reportKey)!;
  if (def.capability && !(await shellCapabilities(orgId)).includes(def.capability)) {
    return NextResponse.json({ error: 'unknown_report', code: 'unknown_report' }, { status: 400 });
  }
  if (input.format !== 'EMAIL_SUMMARY' && !(await entitled(orgId, 'REPORT_EXPORT'))) return locked('REPORT_EXPORT');
  if (input.recipientUserId) {
    const user = await prisma.user.findUnique({ where: { id: input.recipientUserId }, select: { orgId: true, isActive: true } });
    // Another tenant's user reads as "no such user" — the id must not be probeable.
    if (!user || !user.isActive || !(await inCallerTenant(user.orgId, orgId))) {
      return NextResponse.json({ error: 'unknown_recipient', code: 'unknown_recipient' }, { status: 400 });
    }
  }
  return null;
}

/** What the admin screen and API return for one subscription — no other tenant's data, no tokens. */
export const SUBSCRIPTION_SELECT = {
  id: true,
  reportKey: true,
  // The stored slice, if any (#1920): { segmentBy, segment? }.
  params: true,
  cadence: true,
  dayOfWeek: true,
  dayOfMonth: true,
  hour: true,
  locale: true,
  format: true,
  recipientUserId: true,
  recipientEmail: true,
  recipientName: true,
  isActive: true,
  lastSentAt: true,
  createdAt: true,
  recipientUser: { select: { id: true, fullName: true, email: true } },
  sends: { orderBy: { sentAt: 'desc' as const }, take: 10, select: { periodKey: true, status: true, error: true, sentAt: true } },
} as const;
