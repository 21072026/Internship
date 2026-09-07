import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { findMenteesWithMultipleActiveMentors } from '@/lib/activeMentorship';

// GET — READ-ONLY integrity report for "one mentee, at most one ACTIVE mentor"
// (#419). This is how an operator learns whether the LIVE database already
// violates the invariant, which is the precondition for adding the DB-level
// @@unique([activeMenteeKey]) backstop: `prisma db push --accept-data-loss`
// would fail on a violating row, and that push is how this app deploys.
//
// There is no POST, PUT or DELETE on this route, and there never should be:
// remediation is the existing "Mark complete" action on /admin/mentorship,
// which writes a real StatusChange and an honest completedAt. Deciding which of
// two mentors is the real one is not a thing an endpoint may do unattended.
//
// The report shares its `status: 'ACTIVE'` filter with every write guard via
// src/lib/activeMentorship.ts — if the two definitions drifted by one status
// value, this would say clean and the constraint would still fail on deploy.
// The same numbers are printed on every deploy by
// prisma/check-active-mentor-duplicates.mjs.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Scoped by the tenant middleware, same as every other admin read: an admin
  // sees their own org's violations. The future index is global, so the
  // deploy-time script (which runs unscoped) is the cross-tenant view.
  return await withTenantScope(session, async () => {
    const report = await findMenteesWithMultipleActiveMentors(prisma);
    return NextResponse.json(report);
  });
}
