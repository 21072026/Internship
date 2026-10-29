import { NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { requireRoleOrPermission } from '@/lib/authz';
import { withTenantScope } from '@/lib/orgContext';
import { requireCapability } from '@/lib/capabilityGate';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { assessRelations, HEALTH_RELATION_SELECT, reminderDaysReader } from '@/lib/relationHealthLive';
import { healthTrendFrom, utcDay } from '@/lib/relationHealthTrend';

// GET /api/relation-health?ids=a,b,c — the health badge's data (#1904): score,
// band, reasons and the 30-day series for up to 100 relations, computed by the
// same assessRelations() the admin monitor (#1902) and the nightly sweep use.
// No new computation lives here — only who may read which pair:
//   • ADMIN — any relation of their tenant;
//   • MENTOR — only the relations they mentor (their attention queue already
//     shows them the same reasons).
// An id the caller may not read is simply absent from the answer, the same as
// a missing one. Non-active and dormant pairs are not scored (`excluded`).
// Not to be confused with /api/admin/relation-health/[id] (#1901): that one
// reads one pair's stored snapshot history; this one scores a batch NOW.

const DAY = 24 * 60 * 60 * 1000;
const MAX_IDS = 100;

export async function GET(request: Request) {
  const gate = await requireRoleOrPermission(['MENTOR'], 'analytics.read', { request });
  if ('error' in gate) return gate.error;
  const { session, admin } = gate;
  const capGate = await requireCapability(session.user.orgId, 'mentorship');
  if (capGate) return capGate;

  const ids = [...new Set((new URL(request.url).searchParams.get('ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean))];
  if (ids.length === 0) return NextResponse.json({ health: {} });
  if (ids.length > MAX_IDS) return NextResponse.json({ error: 'too_many', code: 'too_many' }, { status: 400 });

  return withTenantScope(session, async () => {
    const scope: Prisma.MentorshipRelationWhereInput = admin ? {} : { mentorId: session.user.id };
    const rows = await prisma.mentorshipRelation.findMany({
      where: withinTenant({ id: { in: ids }, ...scope }, await tenantWhere(session)),
      select: HEALTH_RELATION_SELECT,
    });
    const now = new Date();
    const [assessed, history] = await Promise.all([
      assessRelations(rows, now, reminderDaysReader()),
      prisma.relationHealthSnapshot.findMany({
        where: { relationId: { in: rows.map((r) => r.id) }, takenOn: { gte: new Date(utcDay(now).getTime() - 31 * DAY) } },
        orderBy: { takenOn: 'asc' },
        select: { relationId: true, takenOn: true, score: true, band: true },
      }),
    ]);
    const historyBy = new Map<string, typeof history>();
    for (const h of history) historyBy.set(h.relationId, [...(historyBy.get(h.relationId) ?? []), h]);

    const health: Record<string, unknown> = {};
    for (const { row, assessment } of assessed) {
      if (assessment.excluded) {
        health[row.id] = { excluded: true };
        continue;
      }
      const trend = healthTrendFrom(historyBy.get(row.id) ?? [], 30, now);
      health[row.id] = { score: assessment.score, band: assessment.band, reasons: assessment.reasons, series: trend.series, trend30: trend.delta30 };
    }
    return NextResponse.json({ health });
  });
}
