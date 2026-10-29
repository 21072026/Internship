import { NextResponse } from 'next/server';
import { requireRoleOrPermission } from '@/lib/authz';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import type { Prisma } from '@prisma/client';

// GET ?q= — global search over users (by name/email) and companies (by name).
// Admins search everyone; mentors search their own mentees.
export async function GET(request: Request) {
  const gate = await requireRoleOrPermission(['MENTOR'], 'user.read', { request });
  if ('error' in gate) return gate.error;
  const { session, admin } = gate;
  return await withTenantScope(session, async () => {
    const q = (new URL(request.url).searchParams.get('q') || '').trim();
    if (q.length < 2) return NextResponse.json({ users: [], companies: [] });

    const isMentor = session.user.role === 'MENTOR';
    const userWhere: Prisma.UserWhereInput = {
      OR: [{ fullName: { contains: q } }, { email: { contains: q } }],
    };
    if (isMentor) {
      userWhere.role = 'MENTEE';
      userWhere.menteeRelations = { some: { mentorId: session.user.id } };
    }

    // The caller's own tenant, by hand (#2542 — src/lib/tenantFilter.ts): the
    // middleware injects nothing while MT_ENFORCE_ISOLATION is off, and this box
    // matches on NAME AND E-MAIL. Since one person can hold an account in each
    // world under the same address (#2590), an unscoped search for that address
    // would hand an admin of one product the person's account in the other —
    // its existence, name and role — which is precisely what the separation
    // exists to keep apart. Companies are tenant data too. A no-op for a
    // single-tenant deployment (every row is the default org's).
    const tenant = await tenantWhere(session);

    const [users, companies] = await Promise.all([
      prisma.user.findMany({
        where: withinTenant(userWhere, tenant),
        select: {
          id: true, fullName: true, email: true, role: true,
          menteeRelations: isMentor ? { where: { mentorId: session.user.id }, select: { id: true }, take: 1 } : false,
        },
        take: 8,
        orderBy: { fullName: 'asc' },
      }),
      admin
        ? prisma.company.findMany({ where: withinTenant({ name: { contains: q } }, tenant), select: { id: true, name: true }, take: 5 })
        : Promise.resolve([]),
    ]);

    const usersOut = users.map((u) => ({
      id: u.id,
      fullName: u.fullName,
      email: u.email,
      role: u.role,
      relationId: isMentor ? ((u as { menteeRelations?: { id: string }[] }).menteeRelations?.[0]?.id ?? null) : null,
    }));

    return NextResponse.json({ users: usersOut, companies });
  });
}
