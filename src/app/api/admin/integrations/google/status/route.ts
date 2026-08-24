import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { isGoogleCalendarConfigured, isGoogleCalendarEnabled } from '@/lib/googleCalendar';
import { prisma } from '@/lib/prisma';

// GET — the deployment-wide state of the Google Calendar integration (#417,
// #709). The client integrations page reads env only through this endpoint.
//
// `configured` and `enabled` are different questions and both are reported:
// credentials can sit in the env for a staging trial long before the operator
// wants meetings flowing into real calendars. `connections` counts the people
// who have connected their OWN account — an operator-level health figure, not
// anyone's identity.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const connections = await prisma.googleCalendarConnection.count();
  return NextResponse.json({
    configured: isGoogleCalendarConfigured(),
    enabled: isGoogleCalendarEnabled(),
    connections,
    // Kept for the existing integrations UI, which reads a boolean.
    connected: connections > 0,
  });
}
