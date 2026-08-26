import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { buildMeetingIcs } from '@/lib/ics';

// GET — public .ics for a meeting, addressed by its unguessable RSVP token
// (the same credential used for the email RSVP links).
//
// An external guest's token works here too (#1430): they have no account, so
// the .ics is the only way the meeting reaches their calendar at all, and the
// file exposes nothing the invite email did not already tell them.
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let meeting = await prisma.meeting.findUnique({ where: { rsvpToken: token } });
  if (!meeting) {
    const guest = await prisma.meetingGuest.findUnique({
      where: { rsvpToken: token },
      select: { meeting: true },
    });
    meeting = guest?.meeting ?? null;
  }
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
