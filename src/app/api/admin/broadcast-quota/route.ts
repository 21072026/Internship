import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { broadcastQuotaStatus } from '@/lib/broadcastQuota';

/**
 * GET — this tenant's broadcast meter for the current calendar month (#1754).
 *
 * Read by the announcement and newsletter composers so an admin sees "used X of
 * Y this month" BEFORE writing a blast, rather than discovering the band by
 * being refused. `limit: null` (and therefore `used: null`) means the band is
 * unlimited, which is what today's grandfathered single-tenant install returns.
 */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  return withTenantScope(session, async () =>
    NextResponse.json(await broadcastQuotaStatus(resolveOrgId(session))),
  );
}
