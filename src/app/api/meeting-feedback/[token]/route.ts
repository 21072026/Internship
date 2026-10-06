import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { enforceRateLimit } from '@/lib/rateLimit';
import { verifyMeetingFeedbackToken, DID_NOT_MEET } from '@/lib/meetingFeedbackToken';
import { FeedbackNotAllowed, ownMeetingFeedback, recordMeetingFeedback } from '@/lib/meetingFeedback';

// The one-click path of the "how was it?" e-mail (#1896). No session: the
// signed token (src/lib/meetingFeedbackToken.ts) names the meeting, the rater
// and the rating, and is only ever mailed to that rater.
//
// GET reads — what the page needs to say "you are rating X" — and never
// writes: mail scanners prefetch links. POST records the token's rating (and
// an optional note), and is idempotent: a second click updates the same row.

const bodySchema = z.object({ note: z.string().trim().max(2000).nullable().optional() }).strict();

async function resolve(request: Request, rawToken: string) {
  const limited = enforceRateLimit(request, 'meeting-feedback-token', { limit: 60, windowMs: 10 * 60 * 1000 });
  if (limited) return { response: limited };
  let token = rawToken;
  try {
    token = decodeURIComponent(rawToken);
  } catch {
    /* keep the raw segment */
  }
  const action = verifyMeetingFeedbackToken(token);
  if (action === 'expired') return { response: NextResponse.json({ error: 'expired', expired: true }, { status: 410 }) };
  if (!action) return { response: NextResponse.json({ error: 'invalid' }, { status: 400 }) };
  const user = await prisma.user.findUnique({ where: { id: action.userId }, select: { isActive: true } });
  if (!user?.isActive) return { response: NextResponse.json({ error: 'inactive' }, { status: 403 }) };
  return { action };
}

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const r = await resolve(request, token);
  if (r.response) return r.response;
  const meeting = await prisma.meeting.findUnique({ where: { id: r.action.meetingId }, select: { title: true, scheduledAt: true } });
  if (!meeting) return NextResponse.json({ error: 'invalid' }, { status: 400 });
  return NextResponse.json({ meeting, rating: r.action.rating, feedback: await ownMeetingFeedback(r.action.meetingId, r.action.userId) });
}

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const r = await resolve(request, token);
  if (r.response) return r.response;
  const parsed = bodySchema.safeParse((await request.json().catch(() => ({}))) ?? {});
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input' }, { status: 400 });
  const happened = r.action.rating !== DID_NOT_MEET;
  try {
    const feedback = await recordMeetingFeedback(r.action.meetingId, r.action.userId, {
      happened,
      helpfulness: happened ? r.action.rating : null,
      ...(parsed.data.note !== undefined ? { note: parsed.data.note } : {}),
    });
    return NextResponse.json({ ok: true, feedback });
  } catch (error) {
    if (error instanceof FeedbackNotAllowed) return NextResponse.json({ error: 'invalid' }, { status: 400 });
    throw error;
  }
}
