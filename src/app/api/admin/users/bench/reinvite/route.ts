import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { BENCHED } from '@/lib/participantState';
import { checkReEngagementReminders } from '@/services/emailService';

// POST /api/admin/users/bench/reinvite — "Re-invite the bench" (#1778): the
// EXISTING re-engagement message (src/lib/reEngagement.ts) to everyone on this
// tenant's bench whose "write to them again" date has come. The same consent
// re-check and the same `reEngageNotifiedAt` stamp as the daily reminder, so a
// second click — or the cron afterwards — mails nobody twice.
export async function POST(request: Request) {
  const gate = await requirePermission('user.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  return withTenantScope(session, async () => {
    const bench = await prisma.user.findMany({
      where: withinTenant({ participantState: BENCHED, reEngageAt: { not: null, lte: new Date() }, reEngageNotifiedAt: null }, await tenantWhere(session)),
      select: { id: true },
      take: 1000,
    });
    if (bench.length === 0) return NextResponse.json({ checked: 0, reminded: 0 });
    return NextResponse.json(await checkReEngagementReminders({ userIds: bench.map((u) => u.id) }));
  });
}
