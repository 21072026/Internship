import { NextResponse } from 'next/server';
import { requireRoleOrPermission } from '@/lib/authz';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { hasFeature, entitled } from '@/lib/entitlements';
import { resolveOrgId } from '@/lib/orgScope';
import { recruitingFunnel, recruitingTrend, resolveWindow, sourceBreakdown, timeToFill } from '@/lib/recruitingAnalytics';

// GET — company-scoped analytics: stage distribution, interest summary and
// basic engagement for the company's linked candidates
// (EPIC: company pipeline analytics, roadmap #370) — and, since #1911, the
// recruiting report over the company's applications for a date window
// (?from=&to=&requisitionId=): funnel conversion, time-to-hire, time-to-fill,
// source and monthly trend. The maths is src/lib/recruitingAnalytics.ts; the
// benchmark is its own, entitlement-gated route (./benchmark).
export async function GET(request: Request) {
  const gate = await requireRoleOrPermission(['COMPANY'], 'analytics.read', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;

  // A COMPANY user must be linked to a company; without it there is no scope to
  // apply, so fail closed rather than falling into the unscoped ADMIN branch and
  // leaking every candidate's data. ADMIN sees all (companyId undefined).
  if (session.user.role === 'COMPANY' && !session.user.companyId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  return await withTenantScope(session, async () => {
  const companyId = session.user.role === 'COMPANY' ? session.user.companyId : undefined;
  const params = new URL(request.url).searchParams;
  const recruiting = await recruitingReport({
    companyId: companyId ?? null,
    orgId: resolveOrgId(session),
    from: params.get('from'),
    to: params.get('to'),
    requisitionId: params.get('requisitionId'),
  });
  if (recruiting === 'not_found') return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const canExport = companyId ? await hasFeature(companyId, 'REPORT_EXPORT') : await entitled(resolveOrgId(session), 'REPORT_EXPORT');

  const relations = await prisma.mentorshipRelation.findMany({
    where: companyId ? { companyId } : {},
    select: {
      id: true,
      pipelineStatus: true,
      menteeId: true,
    },
  });

  if (relations.length === 0) {
    return NextResponse.json({
      funnel: {},
      total: 0,
      interestCounts: { INTERESTED: 0, SHORTLISTED: 0, PASS: 0, pending: 0 },
      recruiting,
      canExport,
    });
  }

  const menteeIds = relations.map((r) => r.menteeId);

  // Interest signals from the company across their candidates.
  const interests = await prisma.companyInterest.findMany({
    where: {
      ...(companyId ? { companyId } : {}),
      menteeId: { in: menteeIds },
    },
    select: { menteeId: true, status: true },
  });

  // Funnel: count candidates per pipeline stage.
  const funnel: Record<string, number> = {};
  for (const r of relations) {
    funnel[r.pipelineStatus] = (funnel[r.pipelineStatus] ?? 0) + 1;
  }

  // Interest summary.
  const interestByMentee = new Map(interests.map((i) => [i.menteeId, i.status]));
  const interestCounts = {
    INTERESTED: 0,
    SHORTLISTED: 0,
    PASS: 0,
    pending: 0,
  };
  for (const r of relations) {
    const status = interestByMentee.get(r.menteeId);
    if (status === 'INTERESTED') interestCounts.INTERESTED++;
    else if (status === 'SHORTLISTED') interestCounts.SHORTLISTED++;
    else if (status === 'PASS') interestCounts.PASS++;
    else interestCounts.pending++;
  }

  return NextResponse.json({
    funnel,
    total: relations.length,
    interestCounts,
    recruiting,
    canExport,
  });
  });
}

/**
 * The recruiting report (#1911) for one company (or, for an ADMIN, the org).
 * Every read names the company — a COMPANY session never reaches this with a
 * null companyId, the guard above returns 403 first. A requisitionId that is
 * not the company's answers 'not_found' (the route's 404), never a 403 that
 * would confirm it exists.
 */
async function recruitingReport(params: { companyId: string | null; orgId: string | null; from: string | null; to: string | null; requisitionId: string | null }) {
  const window = resolveWindow({ from: params.from, to: params.to }, new Date());
  const scope = {
    ...(params.companyId ? { companyId: params.companyId } : {}),
    ...(params.orgId ? { orgId: params.orgId } : {}),
  };
  if (params.requisitionId) {
    const owned = await prisma.requisition.findFirst({ where: { id: params.requisitionId, ...scope }, select: { id: true } });
    if (!owned) return 'not_found' as const;
  }
  const byRequisition = params.requisitionId ? { requisitionId: params.requisitionId } : {};
  const inWindow = { gte: window.from, lte: window.to };

  const [apps, events, fills, considered] = await Promise.all([
    // The window's cohort: applications created inside it, with their whole stage history.
    prisma.application.findMany({
      where: { ...scope, ...byRequisition, createdAt: inWindow },
      select: { createdAt: true, source: true, status: true, events: { select: { toStage: true, createdAt: true } } },
    }),
    // Moves made inside the window, whichever month the application started in.
    prisma.applicationEvent.findMany({
      where: { createdAt: inWindow, application: { ...scope, ...byRequisition } },
      select: { fromStage: true, toStage: true, createdAt: true },
    }),
    // A seat is filled when an accepted offer takes it (#1854: requisitionCountedAt).
    prisma.offer.findMany({
      where: {
        status: 'ACCEPTED',
        requisitionCountedAt: inWindow,
        requisitionId: params.requisitionId ?? { not: null },
        ...(params.companyId ? { companyId: params.companyId } : {}),
        ...(params.orgId ? { orgId: params.orgId } : {}),
      },
      select: { requisitionId: true, requisitionCountedAt: true },
    }),
    // Every requisition open at some point in the window — the population time-to-fill is judged against.
    prisma.requisition.count({
      where: { ...scope, ...(params.requisitionId ? { id: params.requisitionId } : {}), createdAt: { lte: window.to }, OR: [{ closedAt: null }, { closedAt: { gte: window.from } }] },
    }),
  ]);
  const openedAt = new Map(
    (await prisma.requisition.findMany({
      where: { id: { in: [...new Set(fills.map((f) => f.requisitionId!))] }, ...scope },
      select: { id: true, createdAt: true },
    })).map((q) => [q.id, q.createdAt]),
  );

  return {
    window: { from: window.from.toISOString(), to: window.to.toISOString() },
    applications: apps.length,
    funnel: recruitingFunnel(apps),
    timeToFill: timeToFill(
      fills.flatMap((f) => (openedAt.has(f.requisitionId!) && f.requisitionCountedAt ? [{ openedAt: openedAt.get(f.requisitionId!)!, filledAt: f.requisitionCountedAt }] : [])),
      considered,
    ),
    sources: sourceBreakdown(apps),
    trend: recruitingTrend(window, apps.map((a) => a.createdAt), events),
  };
}
