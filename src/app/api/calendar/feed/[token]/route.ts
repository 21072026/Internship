import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { buildFeedIcs } from '@/lib/ics';
import { enforceRateLimit } from '@/lib/rateLimit';

// GET — personal ICS subscription feed (#915). Public by design (calendar apps
// can't log in); the unguessable per-user token from /api/account/ics-feed is
// the credential and can be rotated/revoked there. Deliberately PII-minimal:
// each event carries a title and a time, nothing else — no join links, no
// participant names — so a leaked URL exposes as little as possible.
export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const limited = enforceRateLimit(request, 'ics-feed', { limit: 60, windowMs: 10 * 60 * 1000 });
  if (limited) return limited;

  const { token } = await params;
  const user = await prisma.user.findUnique({ where: { icsFeedToken: token }, select: { id: true } });
  if (!user) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // The user's own meetings, on either side of a relation — a window from 30
  // days back (context) to everything scheduled ahead.
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const meetings = await prisma.meeting.findMany({
    where: {
      scheduledAt: { not: null, gte: since },
      relation: { OR: [{ menteeId: user.id }, { mentorId: user.id }] },
    },
    select: { id: true, title: true, scheduledAt: true },
    orderBy: { scheduledAt: 'asc' },
    take: 500,
  });

  const ics = buildFeedIcs(
    'InternshipCRM',
    meetings.map((m) => ({ uid: m.id, title: m.title, start: m.scheduledAt! }))
  );
  return new NextResponse(ics, {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="internship-crm.ics"',
      'Cache-Control': 'private, max-age=300',
    },
  });
}
