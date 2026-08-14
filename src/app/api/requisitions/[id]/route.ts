import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import type { Session } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { closedAtForStatus, normalizeSkills, protectedFields, requisitionPatchSchema } from '@/lib/requisitions';

type Context = { params: Promise<{ id: string }> };

function scopeFor(session: Session | null) {
  if (!session) return { error: NextResponse.json({ error: 'Unauthorized', code: 'unauthorized' }, { status: 401 }) };
  if (session.user.role !== 'ADMIN' && session.user.role !== 'COMPANY') return { error: NextResponse.json({ error: 'Forbidden', code: 'forbidden' }, { status: 403 }) };
  const orgId = resolveOrgId(session);
  if (!orgId) return { error: NextResponse.json({ error: 'Organization is required', code: 'organization_required' }, { status: 403 }) };
  if (session.user.role === 'COMPANY' && !session.user.companyId) return { error: NextResponse.json({ error: 'Company assignment is required', code: 'company_not_assigned' }, { status: 403 }) };
  return { session, orgId };
}

export async function GET(_request: Request, { params }: Context) {
  const { id } = await params;
  const scope = scopeFor(await getServerSession(authOptions));
  if ('error' in scope) return scope.error;
  return withTenantScope(scope.session, async () => {
    const requisition = await prisma.requisition.findFirst({
      where: { id, orgId: scope.orgId, ...(scope.session.user.role === 'COMPANY' ? { companyId: scope.session.user.companyId! } : {}) },
      include: { company: { select: { id: true, name: true } }, owner: { select: { id: true, fullName: true } } },
    });
    return requisition ? NextResponse.json({ requisition }) : NextResponse.json({ error: 'Requisition not found', code: 'not_found' }, { status: 404 });
  });
}

export async function PATCH(request: Request, { params }: Context) {
  const { id } = await params;
  const scope = scopeFor(await getServerSession(authOptions));
  if ('error' in scope) return scope.error;
  return withTenantScope(scope.session, async () => {
    const body: unknown = await request.json().catch(() => null);
    const protectedList = protectedFields(body);
    if (protectedList.length) return NextResponse.json({ error: 'These requisition fields cannot be changed', fields: protectedList, code: 'protected_fields' }, { status: 403 });
    if (body && typeof body === 'object' && !Array.isArray(body) && 'companyId' in body) {
      return NextResponse.json({ error: 'Company cannot be changed', fields: ['companyId'], code: 'protected_fields' }, { status: 403 });
    }
    const parsed = requisitionPatchSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed', code: 'validation_failed', details: parsed.error.flatten() }, { status: 400 });
    if (!Object.keys(parsed.data).length) return NextResponse.json({ error: 'No changes supplied', code: 'validation_failed' }, { status: 400 });

    return prisma.$transaction(async (tx) => {
      const current = await tx.requisition.findFirst({
        where: { id, orgId: scope.orgId, ...(scope.session.user.role === 'COMPANY' ? { companyId: scope.session.user.companyId! } : {}) },
      });
      if (!current) return NextResponse.json({ error: 'Requisition not found', code: 'not_found' }, { status: 404 });
      const openings = parsed.data.openings ?? current.openings;
      const filled = parsed.data.filled ?? current.filled;
      if (filled > openings) return NextResponse.json({ error: 'Filled cannot exceed openings', code: 'filled_exceeds_openings' }, { status: 409 });
      if (parsed.data.ownerId && !(await tx.user.findFirst({ where: { id: parsed.data.ownerId, orgId: scope.orgId, companyId: current.companyId, role: 'COMPANY', isActive: true }, select: { id: true } }))) {
        return NextResponse.json({ error: 'Owner must be an active company user in the same organization and company', code: 'invalid_owner' }, { status: 400 });
      }
      let skills: string[] | undefined;
      try { skills = parsed.data.requiredSkills ? normalizeSkills(parsed.data.requiredSkills) : undefined; }
      catch { return NextResponse.json({ error: 'A required skill is too long', code: 'invalid_required_skills' }, { status: 400 }); }
      const status = parsed.data.status ?? current.status;
      const changed = await tx.requisition.updateMany({
        where: { id: current.id, orgId: scope.orgId, companyId: current.companyId, openings: current.openings, filled: current.filled },
        data: {
          ...parsed.data,
          ...(skills ? { requiredSkills: skills } : {}),
          description: parsed.data.description === undefined ? undefined : parsed.data.description || null,
          city: parsed.data.city === undefined ? undefined : parsed.data.city || null,
          workMode: parsed.data.workMode === undefined ? undefined : parsed.data.workMode || null,
          startDate: parsed.data.startDate === undefined ? undefined : parsed.data.startDate ? new Date(parsed.data.startDate) : null,
          ownerId: parsed.data.ownerId === undefined ? undefined : parsed.data.ownerId || null,
          closedAt: closedAtForStatus(status, current.closedAt),
        },
      });
      if (changed.count !== 1) return NextResponse.json({ error: 'Requisition changed concurrently; reload and try again', code: 'concurrent_update' }, { status: 409 });
      const requisition = await tx.requisition.findUnique({ where: { id: current.id }, include: { company: { select: { id: true, name: true } }, owner: { select: { id: true, fullName: true } } } });
      return NextResponse.json({ requisition });
    });
  });
}
