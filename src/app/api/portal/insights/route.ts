import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { withTenantScope } from '@/lib/orgContext';
import { getOwnMenteeActivity } from '@/lib/activityReport';
import { hasConsent } from '@/lib/consent';
import { canUsePortal } from '@/lib/dualRole';
import { insightsWindowFrom } from '@/lib/portalInsightsQuery';
import { requireCapability } from '@/lib/capabilityGate';

// GET — the caller's own activity summary (#1915), over `?days=1|7|30` or a
// `?from=&to=` date range (#1909; src/lib/portalInsightsWindow.ts decides).
//
// The mentee-facing half of the report `/mentor/mentee-activity` and
// `/admin/mentee-activity` already show about them. Two deliberate properties:
// there is no mentee id parameter, so the subject is always `session.user.id`
// and there is nothing to tamper with; and there is no entitlement, plan or
// quota check, because reading your own data is never a paid feature.
// `trackingConsent` rides along so the caller can render an explicit consent
// state instead of the zeros an opted-out mentee would otherwise be shown as if
// they were inactivity.
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  // A mentee's portal insights (P3, MKT-6).
  const capGate = await requireCapability(session.user.orgId, 'mentorship');
  if (capGate) return capGate;
  // Gated exactly like the portal shell rather than on `role === 'MENTEE'`: an
  // admin or mentor who is themselves being mentored legitimately lives in the
  // portal (#1141), and their own summary is theirs to read.
  if (!(await canUsePortal(session.user))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  return withTenantScope(session, async () => {
    const period = insightsWindowFrom(new URL(request.url).searchParams);

    const activity = await getOwnMenteeActivity(session.user.id, period.from, period.to);
    if (!activity) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    return NextResponse.json({
      days: period.days,
      from: period.from.toISOString(),
      to: period.to.toISOString(),
      trackingConsent: await hasConsent(session.user.id, 'ACTIVITY_TRACKING'),
      activity,
    });
  });
}
