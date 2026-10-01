import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { withRequestScope } from '@/lib/requestContext';
import { resolvePipelineStages, outcomeStageKeysFrom } from '@/lib/pipelineStages';
import { onPathKeys } from '@/lib/pipeline';
import { cohortMonths } from '@/lib/funnelKpi';
import { shellCapabilities } from '@/lib/shellCapabilities';
import { rangeEnd, rangeStart } from '@/lib/dateRange';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { isDealValueEnabled, valueByMonth, type ValueJourney } from '@/lib/dealValue';

// GET /api/admin/analytics/deal-value — the ESTIMATED value of won deals,
// month by month (#2422, story #2393): per month, what was newly won, what was
// lost (the retention triangle's churn), and the estimated monthly value of the
// accounts held at the month's end. The arithmetic is src/lib/dealValue.ts; this
// route only loads the rows.
//
// Every month is rebuilt from StatusChange, never from today's pipelineStatus:
// the relation's current stage is read only as the start stage of a record
// that never moved (the same reading the funnel route gives it), and a deal won
// before the window still counts in the window's month-end book — which is why
// the query takes every record that STARTED before the window closed, not just
// the ones that moved inside it.
//
// ADMIN only, own tenant, and only for a vertical that uses deal values
// (MARKETING): anyone else gets `{ enabled: false }` and the card is not drawn.

export async function GET(request: Request) {
  return withRequestScope(request, async () => {
    const session = await getServerSession(authOptions);
    if (!session || session.user.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
      return await withTenantScope(session, async () => {
        const orgId = (session.user as { orgId?: string | null }).orgId ?? null;
        const capabilities = await shellCapabilities(orgId);
        if (!isDealValueEnabled(capabilities)) return NextResponse.json({ enabled: false });

        // Same window grammar as the funnel route: whole days, and with no range
        // the last twelve months.
        const { searchParams } = new URL(request.url);
        const from = rangeStart(searchParams.get('from'));
        const to = rangeEnd(searchParams.get('to'));
        const rangeOk = !!(from && to && from.getTime() <= to.getTime());
        const windowEnd = rangeOk ? to! : new Date();
        const windowStart = rangeOk
          ? from!
          : new Date(Date.UTC(windowEnd.getUTCFullYear(), windowEnd.getUTCMonth() - 11, 1));
        const months = cohortMonths(windowStart, windowEnd);

        // The caller's tenant, by hand (leak audit WP3): `withTenantScope` is a
        // passthrough with MT_ENFORCE_ISOLATION off, so a MARKETING org's book
        // was valued over every org's won relations.
        const tenant = await tenantWhere(session);
        const relations = await prisma.mentorshipRelation.findMany({
          where: withinTenant({ startDate: { lte: windowEnd } }, tenant),
          select: {
            id: true,
            previousRelationId: true,
            pipelineStatus: true,
            startDate: true,
            value: { select: { valueMinor: true, currency: true } },
            // ALL of them, not just the window's: the first move's `fromStatus`
            // is where the record started, and a record that moved only after
            // the window would otherwise start on today's stage. Moves after a
            // month closed are ignored by the arithmetic for that month anyway.
            statusChanges: {
              orderBy: { createdAt: 'asc' },
              select: { fromStatus: true, toStatus: true, createdAt: true },
            },
          },
        });

        const stages = await resolvePipelineStages(orgId);
        const order = onPathKeys(stages);
        const outcome = outcomeStageKeysFrom(stages);

        const journeys: ValueJourney[] = relations.map((r) => ({
          id: r.id,
          previousRelationId: r.previousRelationId,
          startStatus: r.statusChanges[0]?.fromStatus ?? r.pipelineStatus,
          startedAt: r.startDate.getTime(),
          changes: r.statusChanges.map((c) => ({ toStatus: c.toStatus, at: c.createdAt.getTime() })),
          valueMinor: r.value?.valueMinor ?? null,
          currency: r.value?.currency ?? null,
        }));

        const result = valueByMonth(order, journeys, months, {
          wonKeys: outcome.finished,
          offPath: outcome.offPath,
        });
        // Keys, not labels — the screen names a stage through useStageLabel().
        return NextResponse.json({ enabled: true, wonKeys: outcome.finished, ...result });
      });
    } catch (error) {
      console.error('Deal value analytics error:', error);
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
  });
}
