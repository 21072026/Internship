import { NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { requirePermission } from '@/lib/authz';
import { withinTenant } from '@/lib/tenantFilter';
import { auditWhereFor } from '@/lib/auditQuery';
import { IMPERSONATION_ACTIVITY, impersonationActivityFor, pairActivity } from '@/lib/auditViewRule';

const PAGE_SIZE = 50;

// GET — the audit trail viewer (#1583): AuditLog rows (impersonation, admin
// password resets, merges, offer and interview decisions) with action / actor /
// target / date filters, the same paging as /api/admin/activity. The filter is
// src/lib/auditQuery.ts, shared with the CSV export (#1585).
//
// Behind the `audit.read` PERMISSION (src/lib/authz.ts), not a role check: an
// OBSERVER may read here, a PROGRAM_ADMIN reads only the rows whose target is a
// person inside its grants, and every refusal is an authz.capability_denied row.
//
// The org is the caller's own, from the session — never the query string. A
// super admin reads their own org's trail here like any other admin; nothing on
// this route crosses a tenant (the platform powers are `platform.*`).
export async function GET(request: Request) {
  const gate = await requirePermission('audit.read', { request, listing: true });
  if ('error' in gate) return gate.error;

  const sp = new URL(request.url).searchParams;
  const page = Math.max(1, Number(sp.get('page')) || 1);
  const built = await auditWhereFor(sp, gate);
  if (built === 'invalid_date') return NextResponse.json({ error: 'invalid_date' }, { status: 400 });
  const { where, tenant } = built;

  const [rows, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: { id: true, action: true, actorId: true, targetId: true, detail: true, createdAt: true },
    }),
    prisma.auditLog.count({ where }),
  ]);

  // Names, not cuids. Looked up inside the tenant: an id from another org (or
  // a deleted account) renders as the bare id rather than a stranger's name.
  const ids = [...new Set(rows.flatMap((r) => [r.actorId, r.targetId]).filter((x): x is string => Boolean(x)))];
  const people = ids.length
    ? await prisma.user.findMany({
        where: withinTenant<Prisma.UserWhereInput>({ id: { in: ids } }, tenant),
        select: { id: true, fullName: true, email: true },
      })
    : [];
  const byId = new Map(people.map((p) => [p.id, { id: p.id, name: p.fullName, email: p.email }]));

  // Impersonation writes to both trails: the audit row says who and why, the
  // ActivityLog row carries the IP and the browser. Pair them so a reviewer can
  // pivot from one to the other.
  const imp = rows.filter((r) => impersonationActivityFor(r.action) !== null);
  const activity = imp.length
    ? await prisma.activityLog.findMany({
        where: withinTenant<Prisma.ActivityLogWhereInput>(
          {
            action: { in: Object.values(IMPERSONATION_ACTIVITY) },
            actorId: { in: [...new Set(imp.map((r) => r.actorId))] },
            createdAt: {
              gte: new Date(Math.min(...imp.map((r) => r.createdAt.getTime())) - 60_000),
              lte: new Date(Math.max(...imp.map((r) => r.createdAt.getTime())) + 60_000),
            },
          },
          tenant,
        ),
        select: { id: true, action: true, actorId: true, targetId: true, ip: true, userAgent: true, createdAt: true },
      })
    : [];

  const items = rows.map((r) => ({
    id: r.id,
    action: r.action,
    actorId: r.actorId,
    actor: byId.get(r.actorId) ?? null,
    targetId: r.targetId,
    target: r.targetId ? byId.get(r.targetId) ?? null : null,
    detail: r.detail,
    createdAt: r.createdAt,
    activity: pairActivity(r, activity),
  }));

  return NextResponse.json({ items, total, page, pageSize: PAGE_SIZE });
}
