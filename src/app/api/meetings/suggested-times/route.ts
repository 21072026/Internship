import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { suggestedTimesFor } from '@/lib/suggestedTimesFor';

// GET ?relationId=&duration=&count= — times that work for both people of a
// relation (#1999): the mentor's posted hours, minus everyone's busy windows,
// inside 08:00–20:00 on each person's own clock, within the mentor's booking
// rules (#2003). The arithmetic is src/lib/suggestTimes.ts (pure).
//
// Who may ask: an ADMIN of the org, the pair's mentor, or the mentee of an
// ACTIVE relation — the same set that may book there. The answer is instants
// and each person's zone, never anybody's calendar: a busy hour is simply not
// offered, with no title and no reason attached.

// The body is src/lib/suggestedTimesFor.ts, shared with the chat booking flow (#1951).
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const params = new URL(request.url).searchParams;
  return suggestedTimesFor(session, {
    relationId: params.get('relationId') ?? '',
    count: parseInt(params.get('count') ?? '5', 10) || 5,
    duration: parseInt(params.get('duration') ?? '', 10),
  });
}
