import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import type { Prisma } from '@prisma/client';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { withRequestScope } from '@/lib/requestContext';
import { requireCapability } from '@/lib/capabilityGate';
import { resolveOrgId } from '@/lib/orgScope';
import { getSetting } from '@/lib/settings';
import { settingsOrgOf } from '@/lib/settingsOrg';
import {
  ACCEPTANCE_WINDOW_DAYS,
  HIRING_QUEUE_TAKE,
  OFFER_EXPIRY_WINDOW_DAYS,
  acceptanceRate,
  daysAgo,
  daysAhead,
  monthStartUtc,
  stallDays,
  wholeDaysBetween,
} from '@/lib/hiringQueues';

// GET — the four hiring queues a programme owner works through each morning
// (#1874), plus the header numbers. ADMIN only, tenant-scoped.
//
// Every queue is ONE bounded query with `take` and a `count()` over the same
// `where` — the page costs a constant number of queries whatever the tenant's
// size, and nothing is read whole and filtered in JavaScript (#1436, #1438).
// Nothing is cached in a stored field; every number is computed here.
//
//   awaitingDecision     InterviewRequest PENDING, oldest first
//   stalledApplications  an open Application whose latest ApplicationEvent is
//                        older than `hiringStallDays` (the clock is derived
//                        from the events, #1828 — terminal stages never appear,
//                        because only status ACTIVE is open)
//   offersExpiring       Offer SENT with expiresAt in the next 7 days, soonest first
//   emptyRoles           Requisition OPEN with a seat left and no open application
export async function GET(request: Request) {
  return withRequestScope(request, async () => {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    const capGate = await requireCapability(session.user.orgId, 'placements');
    if (capGate) return capGate;
    const orgId = resolveOrgId(session);
    if (!orgId) return NextResponse.json({ error: 'Organization is required', code: 'organization_required' }, { status: 403 });

    return withTenantScope(session, async () => {
      const now = new Date();
      const stall = stallDays(await getSetting('hiringStallDays', await settingsOrgOf(session)));
      const stallCutoff = daysAgo(now, stall);

      const pendingWhere: Prisma.InterviewRequestWhereInput = { orgId, status: 'PENDING' };
      const stalledWhere: Prisma.ApplicationWhereInput = {
        orgId,
        status: 'ACTIVE',
        createdAt: { lt: stallCutoff },
        events: { none: { createdAt: { gte: stallCutoff } } },
      };
      // Offer is in TENANT_MODELS, but the middleware scopes only under
      // MT_ENFORCE_ISOLATION; the desk is one tenant's work list either way, so
      // every offer read here names the org like the other three queues.
      const expiringWhere: Prisma.OfferWhereInput = { orgId, status: 'SENT', expiresAt: { gte: now, lte: daysAhead(now, OFFER_EXPIRY_WINDOW_DAYS) } };
      const emptyWhere: Prisma.RequisitionWhereInput = {
        orgId,
        status: 'OPEN',
        filled: { lt: prisma.requisition.fields.openings },
        applications: { none: { status: 'ACTIVE' } },
      };

      // The sidebar badge (#1874) wants only the actionable sum — two counts, not the desk.
      if (new URL(request.url).searchParams.get('summary') === '1') {
        const [pendingCount, expiringCount] = await Promise.all([
          prisma.interviewRequest.count({ where: pendingWhere }),
          prisma.offer.count({ where: expiringWhere }),
        ]);
        return NextResponse.json({ actionable: pendingCount + expiringCount });
      }

      const [
        pending, pendingTotal, stalled, stalledTotal, expiring, expiringTotal, empty, emptyTotal,
        openRoles, hiresThisMonth, offersOutstanding, decided,
      ] = await Promise.all([
        prisma.interviewRequest.findMany({
          where: pendingWhere,
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: HIRING_QUEUE_TAKE,
          select: {
            id: true, createdAt: true,
            mentee: { select: { id: true, fullName: true } },
            requisition: { select: { id: true, title: true } },
            company: { select: { id: true, name: true } },
          },
        }),
        prisma.interviewRequest.count({ where: pendingWhere }),
        prisma.application.findMany({
          where: stalledWhere,
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: HIRING_QUEUE_TAKE,
          select: {
            id: true, stage: true, createdAt: true,
            mentee: { select: { id: true, fullName: true } },
            requisition: { select: { id: true, title: true } },
            events: { orderBy: { createdAt: 'desc' }, take: 1, select: { createdAt: true } },
          },
        }),
        prisma.application.count({ where: stalledWhere }),
        prisma.offer.findMany({
          where: expiringWhere,
          orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
          take: HIRING_QUEUE_TAKE,
          select: {
            id: true, position: true, expiresAt: true,
            company: { select: { id: true, name: true } },
            relation: { select: { mentee: { select: { id: true, fullName: true } } } },
          },
        }),
        prisma.offer.count({ where: expiringWhere }),
        prisma.requisition.findMany({
          where: emptyWhere,
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: HIRING_QUEUE_TAKE,
          select: { id: true, title: true, openings: true, filled: true, createdAt: true, company: { select: { id: true, name: true } } },
        }),
        prisma.requisition.count({ where: emptyWhere }),
        prisma.requisition.count({ where: { orgId, status: 'OPEN' } }),
        prisma.application.count({ where: { orgId, status: 'HIRED', decidedAt: { gte: monthStartUtc(now) } } }),
        prisma.offer.count({ where: { orgId, status: 'SENT' } }),
        prisma.offer.groupBy({
          by: ['status'],
          where: { orgId, status: { in: ['ACCEPTED', 'DECLINED', 'EXPIRED'] }, decidedAt: { gte: daysAgo(now, ACCEPTANCE_WINDOW_DAYS) } },
          _count: { _all: true },
        }),
      ]);

      const decidedBy = (status: string) => decided.find((g) => g.status === status)?._count._all ?? 0;

      return NextResponse.json({
        stallDays: stall,
        header: {
          openRoles,
          hiresThisMonth,
          offersOutstanding,
          acceptanceRate: acceptanceRate(decidedBy('ACCEPTED'), decidedBy('DECLINED'), decidedBy('EXPIRED')),
        },
        queues: {
          awaitingDecision: {
            total: pendingTotal,
            items: pending.map((r) => ({
              id: r.id,
              candidate: r.mentee.fullName,
              requisition: r.requisition.title,
              company: r.company.name,
              daysWaiting: wholeDaysBetween(r.createdAt, now),
              href: '/admin/interview-requests',
            })),
          },
          stalledApplications: {
            total: stalledTotal,
            items: stalled.map((a) => ({
              id: a.id,
              candidate: a.mentee.fullName,
              requisition: a.requisition.title,
              stage: a.stage,
              daysWaiting: wholeDaysBetween(a.events[0]?.createdAt ?? a.createdAt, now),
              href: `/admin/candidates/${a.mentee.id}`,
            })),
          },
          offersExpiring: {
            total: expiringTotal,
            items: expiring.map((o) => ({
              id: o.id,
              candidate: o.relation.mentee.fullName,
              position: o.position,
              company: o.company?.name ?? null,
              expiresAt: o.expiresAt,
              href: `/admin/offers?status=SENT&expiringWithinDays=${OFFER_EXPIRY_WINDOW_DAYS}`,
            })),
          },
          emptyRoles: {
            total: emptyTotal,
            items: empty.map((q) => ({
              id: q.id,
              requisition: q.title,
              company: q.company.name,
              openings: q.openings,
              filled: q.filled,
              daysWaiting: wholeDaysBetween(q.createdAt, now),
              href: '/admin/requisitions',
            })),
          },
        },
      });
    });
  });
}
