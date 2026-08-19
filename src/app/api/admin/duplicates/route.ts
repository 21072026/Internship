import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { scanDuplicatePairs } from '@/lib/duplicateDetection';
import { resolveOrgId } from '@/lib/orgScope';
import { withTenantScope } from '@/lib/orgContext';

// GET — full duplicate scan over the org's candidates (#841). Read-only:
// returns every suspicious MENTEE pair, strongest signals first. Feeds the
// admin duplicates page; merging goes through ./merge.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return await withTenantScope(session, async () => {
    const pairs = await scanDuplicatePairs(resolveOrgId(session));
    return NextResponse.json({ pairs });
  });
}
