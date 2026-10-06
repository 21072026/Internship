import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { withTenantScope } from '@/lib/orgContext';
import { enforceRateLimit } from '@/lib/rateLimit';
import { feedbackSchema, FeedbackNotAllowed, ownMeetingFeedback, recordMeetingFeedback } from '@/lib/meetingFeedback';

// "How was the meeting?" from inside the app (#1896) — the inline card after
// "mark meeting ended". POST records (or updates) the caller's own answer;
// GET returns the caller's own answer only. Nobody reads anyone else's
// individual answer through this route — or any other.

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  return withTenantScope(session, async () => NextResponse.json({ feedback: await ownMeetingFeedback(id, session.user.id) }));
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const limited = enforceRateLimit(request, 'meeting-feedback', { limit: 30, windowMs: 10 * 60 * 1000 });
  if (limited) return limited;
  const parsed = feedbackSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input' }, { status: 400 });
  const { id } = await params;
  return withTenantScope(session, async () => {
    try {
      return NextResponse.json({ feedback: await recordMeetingFeedback(id, session.user.id, parsed.data) });
    } catch (error) {
      // Not a participant and not a rateable meeting answer alike: the id space stays opaque.
      if (error instanceof FeedbackNotAllowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      throw error;
    }
  });
}
