import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { isGoogleCalendarConfigured, isGoogleCalendarEnabled } from '@/lib/googleCalendar';
import { disconnect } from '@/lib/googleCalendarClient';
import { logActivity } from '@/lib/activity';

// GET — this user's own Google Calendar connection state (#709).
// Never returns a token, only whether one exists and which account it belongs
// to, so the person can tell what they are about to disconnect.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const conn = await prisma.googleCalendarConnection.findUnique({
    where: { userId: session.user.id },
    select: { googleEmail: true, calendarId: true, lastSyncAt: true, lastError: true, createdAt: true },
  });
  return NextResponse.json({
    configured: isGoogleCalendarConfigured(),
    enabled: isGoogleCalendarEnabled(),
    connected: !!conn,
    connection: conn,
  });
}

// DELETE — revoke at Google and forget the tokens.
export async function DELETE(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  await disconnect(session.user.id);
  await logActivity({
    action: 'google_calendar.disconnected',
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    targetType: 'user',
    targetId: session.user.id,
    request,
  });
  return NextResponse.json({ ok: true });
}
