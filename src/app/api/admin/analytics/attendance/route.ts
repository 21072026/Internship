import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { withTenantScope } from '@/lib/orgContext';
import { tenantWhere } from '@/lib/tenantFilter';
import { loadProgrammeAttendance } from '@/lib/meetingCadenceData';

// The programme's meeting attendance figures (#2014): pairs that met in the
// last 30 days, pairs on their promised cadence, the no-show rate and the
// median gap between meetings — each with the count behind it, and suppressed
// below the reporting floor. Deterministic arithmetic (src/lib/meetingCadence.ts).
export async function GET(request: Request) {
  const gate = await requirePermission('analytics.read', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  return withTenantScope(session, async () => NextResponse.json({ attendance: await loadProgrammeAttendance(await tenantWhere(session)) }));
}
