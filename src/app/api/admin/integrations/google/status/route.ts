import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { isGoogleCalendarConfigured } from '@/lib/googleCalendar';

// GET — whether Google Calendar OAuth is configured on this deployment (#417).
// The client integrations page reads env only through this server endpoint.
// `connected` is always false for now: user-token storage lands with the
// callback wiring (docs/google-calendar.md) once credentials exist.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return NextResponse.json({ configured: isGoogleCalendarConfigured(), connected: false });
}
