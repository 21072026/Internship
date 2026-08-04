import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { withTenantScope } from '@/lib/orgContext';
import { getUpcomingMeeting, MEETING_DURATION_MINUTES, MEETING_LEAD_MINUTES } from '@/lib/upcomingMeeting';

// GET — the meeting this user is about to have, or is having right now (#51
// follow-up). Polled by the dashboard banner and the header's join pill, so it
// answers for the caller only and stays a single cheap query set.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  return await withTenantScope(session, async () => {
    const meeting = await getUpcomingMeeting(session.user.id);
    return NextResponse.json(
      { meeting, leadMinutes: MEETING_LEAD_MINUTES, durationMinutes: MEETING_DURATION_MINUTES },
      // The answer changes by the minute; never let a proxy hold onto it.
      { headers: { 'Cache-Control': 'no-store' } }
    );
  });
}
