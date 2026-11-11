import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
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
export async function GET(request: Request) {
  const gate = await requirePermission('mail.read', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;

  return withTenantScope(session, async () =>
    NextResponse.json(await broadcastQuotaStatus(resolveOrgId(session))),
  );
}
