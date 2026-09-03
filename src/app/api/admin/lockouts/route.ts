import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { withTenantScope } from '@/lib/orgContext';
import { listActiveLockouts } from '@/lib/accountLockout';

// GET — which accounts are currently locked out by brute-force protection.
//
// Its own endpoint rather than another column on /api/users: the user list is
// paginated and cached per view, lockouts are a handful of short-lived rows,
// and keeping them apart means the directory query is untouched.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return await withTenantScope(session, async () => {
    const lockouts = await listActiveLockouts();
    return NextResponse.json({ lockouts });
  });
}
