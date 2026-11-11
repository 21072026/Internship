import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { isMicrosoftCalendarConfigured, isMicrosoftCalendarEnabled } from '@/lib/microsoftCalendar';
import { disconnectMicrosoft } from '@/lib/microsoftCalendarClient';
import { logActivity } from '@/lib/activity';

// GET — this user's own Microsoft calendar connection (#1991). Never a token:
// the select is an allowlist, so a token column cannot reach the response.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const conn = await prisma.calendarConnection.findUnique({
    where: { userId_provider: { userId: session.user.id, provider: 'MICROSOFT' } },
    select: { accountEmail: true, calendarId: true, lastSyncAt: true, lastError: true, createdAt: true },
  });
  return NextResponse.json({
    configured: isMicrosoftCalendarConfigured(),
    enabled: isMicrosoftCalendarEnabled(),
    connected: !!conn,
    connection: conn,
  });
}

// DELETE — forget the tokens (and, by cascade, the event links).
export async function DELETE(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  await disconnectMicrosoft(session.user.id);
  await logActivity({
    action: 'microsoft_calendar.disconnected',
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    targetType: 'user',
    targetId: session.user.id,
    request,
  });
  return NextResponse.json({ ok: true });
}
