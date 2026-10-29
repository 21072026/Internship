import { NextResponse } from 'next/server';
import { scanDuplicatePairs } from '@/lib/duplicateDetection';
import { resolveOrgId } from '@/lib/orgScope';
import { withTenantScope } from '@/lib/orgContext';
import { requirePermission } from '@/lib/authz';

// GET — full duplicate scan over the org's candidates (#841). Read-only:
// returns every suspicious MENTEE pair, strongest signals first. Feeds the
// admin duplicates page; merging goes through ./merge.
export async function GET(request: Request) {
  const gate = await requirePermission('user.read', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;

  return await withTenantScope(session, async () => {
    const pairs = await scanDuplicatePairs(resolveOrgId(session));
    return NextResponse.json({ pairs });
  });
}
