import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
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
export async function GET(request: Request) {
  const gate = await requirePermission('org.integrations.read', { request });
  if ('error' in gate) return gate.error;
  const connections = await prisma.calendarConnection.count({ where: { provider: 'GOOGLE' } });
  return NextResponse.json({
    configured: isGoogleCalendarConfigured(),
    enabled: isGoogleCalendarEnabled(),
    connections,
    // Kept for the existing integrations UI, which reads a boolean.
    connected: connections > 0,
  });
}
