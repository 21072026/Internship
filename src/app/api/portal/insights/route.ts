import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { withTenantScope } from '@/lib/orgContext';
import { getOwnMenteeActivity } from '@/lib/activityReport';
import { hasConsent } from '@/lib/consent';
import { canUsePortal } from '@/lib/dualRole';

const ALLOWED_DAYS = [1, 7, 30];

// GET — the caller's own activity summary (#1915).
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
  // Gated exactly like the portal shell rather than on `role === 'MENTEE'`: an
  // admin or mentor who is themselves being mentored legitimately lives in the
  // portal (#1141), and their own summary is theirs to read.
  if (!(await canUsePortal(session.user))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  return withTenantScope(session, async () => {
    const requested = Number(new URL(request.url).searchParams.get('days'));
    const days = ALLOWED_DAYS.includes(requested) ? requested : 7;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const activity = await getOwnMenteeActivity(session.user.id, since);
    if (!activity) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    return NextResponse.json({
      days,
      trackingConsent: await hasConsent(session.user.id, 'ACTIVITY_TRACKING'),
      activity,
    });
  });
}
