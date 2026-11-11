import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { prisma } from '@/lib/prisma';
import { resolveOrgId } from '@/lib/orgScope';
import { inCallerTenant } from '@/lib/tenantFilter';
import { healthTrendFrom, SNAPSHOT_RETENTION_DAYS } from '@/lib/relationHealthTrend';
import { HEALTH_RULES_VERSION } from '@/lib/relationHealth';

// GET /api/admin/relation-health/[id]?days=90 — one relationship's health
// history (#1901): the daily series the nightly sweep recorded, the 7/30-day
// delta, and the latest snapshot's reasons. Numbers only; a screen draws them
// with the product's own CSS bars (no chart library).
//
// ADMIN, and the relation must be the caller's tenant's — another tenant's id
// is a 404, so ids cannot be probed.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission('analytics.read', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const { id } = await params;
  const relation = await prisma.mentorshipRelation.findUnique({ where: { id }, select: { orgId: true } });
  if (!relation || !(await inCallerTenant(relation.orgId, resolveOrgId(session)))) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const requested = parseInt(new URL(request.url).searchParams.get('days') || '90', 10);
  const days = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), SNAPSHOT_RETENTION_DAYS) : 90;
  const snapshots = await prisma.relationHealthSnapshot.findMany({
    where: { relationId: id, takenOn: { gte: new Date(Date.now() - (days + 31) * 24 * 60 * 60 * 1000) } },
    orderBy: { takenOn: 'asc' },
    select: { takenOn: true, score: true, band: true, reasons: true, rulesVersion: true },
  });
  const latest = snapshots.at(-1) ?? null;
  return NextResponse.json({
    ...healthTrendFrom(snapshots, days, new Date()),
    latest: latest ? { day: latest.takenOn.toISOString().slice(0, 10), score: latest.score, band: latest.band, reasons: latest.reasons, rulesVersion: latest.rulesVersion } : null,
    rulesVersion: HEALTH_RULES_VERSION,
  });
}
