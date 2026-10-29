import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { withTenantScope } from '@/lib/orgContext';
import { listActiveLockouts } from '@/lib/accountLockout';
import { tenantWhere } from '@/lib/tenantFilter';

// GET — which accounts are currently locked out by brute-force protection.
//
// Its own endpoint rather than another column on /api/users: the user list is
// paginated and cached per view, lockouts are a handful of short-lived rows,
// and keeping them apart means the directory query is untouched.
export async function GET(request: Request) {
  const gate = await requirePermission('user.read', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  return await withTenantScope(session, async () => {
    // The caller's own tenant, by hand (#2542, #2590) — see listActiveLockouts.
    const lockouts = await listActiveLockouts(await tenantWhere(session));
    return NextResponse.json({ lockouts });
  });
}
