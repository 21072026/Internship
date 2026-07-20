import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { buildMeetingIcs } from '@/lib/ics';

// GET — public .ics for a meeting, addressed by its unguessable RSVP token
// (the same credential used for the email RSVP links).
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const meeting = await prisma.meeting.findUnique({ where: { rsvpToken: token } });
  if (!meeting) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  // A no-time meeting has nothing to put in a calendar file.
  if (!meeting.scheduledAt) return NextResponse.json({ error: 'Meeting has no scheduled time' }, { status: 400 });

  const ics = buildMeetingIcs({
    uid: meeting.id,
    title: meeting.title,
    start: meeting.scheduledAt,
    description: meeting.meetLink ? `Join: ${meeting.meetLink}` : null,
    location: meeting.meetLink ?? null,
  });

  return new NextResponse(ics, {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `attachment; filename="meeting.ics"`,
    },
  });
}
