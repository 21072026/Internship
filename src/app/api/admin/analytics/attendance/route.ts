import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { withTenantScope } from '@/lib/orgContext';
import { tenantWhere } from '@/lib/tenantFilter';
import { loadProgrammeAttendance } from '@/lib/meetingCadenceData';

// The programme's meeting attendance figures (#2014): pairs that met in the
// last 30 days, pairs on their promised cadence, the no-show rate and the
// median gap between meetings — each with the count behind it, and suppressed
// below the reporting floor. Deterministic arithmetic (src/lib/meetingCadence.ts).
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  return withTenantScope(session, async () => NextResponse.json({ attendance: await loadProgrammeAttendance(await tenantWhere(session)) }));
}
