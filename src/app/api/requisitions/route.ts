import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import type { Prisma } from '@prisma/client';
import type { Session } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import {
  REQUISITION_LIMITS, REQUISITION_STATUSES, closedAtForStatus, normalizeSkills,
  protectedFields, requisitionInputSchema, validateRequisitionOwner,
} from '@/lib/requisitions';

function authScope(session: Session | null) {
  if (!session) return { error: NextResponse.json({ error: 'Unauthorized', code: 'unauthorized' }, { status: 401 }) };
  if (session.user.role !== 'ADMIN' && session.user.role !== 'COMPANY') {
    return { error: NextResponse.json({ error: 'Forbidden', code: 'forbidden' }, { status: 403 }) };
  }
  const orgId = resolveOrgId(session);
  if (!orgId) return { error: NextResponse.json({ error: 'Organization is required', code: 'organization_required' }, { status: 403 }) };
  if (session.user.role === 'COMPANY' && !session.user.companyId) {
    return { error: NextResponse.json({ error: 'Company assignment is required', code: 'company_not_assigned' }, { status: 403 }) };
  }
  return { session, orgId };
}

export async function GET(request: Request) {
  const scope = authScope(await getServerSession(authOptions));
  if ('error' in scope) return scope.error;
  return withTenantScope(scope.session, async () => {
    const params = new URL(request.url).searchParams;
    const page = Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1);
    const pageSize = Math.min(REQUISITION_LIMITS.pageSize, Math.max(1, Number.parseInt(params.get('pageSize') ?? '20', 10) || 20));
    const requestedCompanyId = params.get('companyId') || undefined;
    const status = params.get('status') || undefined;
    const search = params.get('search')?.trim();
    if (status && !REQUISITION_STATUSES.includes(status as (typeof REQUISITION_STATUSES)[number])) {
      return NextResponse.json({ error: 'Invalid status', code: 'invalid_status' }, { status: 400 });
    }
    const where: Prisma.RequisitionWhereInput = {
      orgId: scope.orgId,
      ...(scope.session.user.role === 'COMPANY'
        ? { companyId: scope.session.user.companyId! }
        : requestedCompanyId ? { companyId: requestedCompanyId } : {}),
      ...(status ? { status } : {}),
      ...(search ? { OR: [{ title: { contains: search } }, { company: { name: { contains: search } } }] } : {}),
    };
    const [items, total, companies, owners] = await prisma.$transaction([
      prisma.requisition.findMany({
        where, skip: (page - 1) * pageSize, take: pageSize,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: { company: { select: { id: true, name: true } }, owner: { select: { id: true, fullName: true } } },
      }),
      prisma.requisition.count({ where }),
      prisma.company.findMany({
        where: { orgId: scope.orgId, ...(scope.session.user.role === 'COMPANY' ? { id: scope.session.user.companyId! } : {}) },
        select: { id: true, name: true }, orderBy: { name: 'asc' },
      }),
      prisma.user.findMany({
        where: { orgId: scope.orgId, role: 'COMPANY', isActive: true, ...(scope.session.user.role === 'COMPANY' ? { companyId: scope.session.user.companyId! } : {}) },
        select: { id: true, fullName: true, companyId: true }, orderBy: { fullName: 'asc' },
      }),
    ]);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    return NextResponse.json({ requisitions: items, companies, owners, page, pageSize, total, totalPages, hasMore: page < totalPages });
  });
}

export async function POST(request: Request) {
  const scope = authScope(await getServerSession(authOptions));
  if ('error' in scope) return scope.error;
  return withTenantScope(scope.session, async () => {
    const body: unknown = await request.json().catch(() => null);
    const protectedList = protectedFields(body);
    if (protectedList.length) return NextResponse.json({ error: 'These requisition fields cannot be changed', fields: protectedList, code: 'protected_fields' }, { status: 403 });
    const parsed = requisitionInputSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed', code: 'validation_failed', details: parsed.error.flatten() }, { status: 400 });
    const data = parsed.data;
    if (data.filled > data.openings) return NextResponse.json({ error: 'Filled cannot exceed openings', code: 'filled_exceeds_openings' }, { status: 409 });
    const companyId = scope.session.user.role === 'COMPANY' ? scope.session.user.companyId! : data.companyId;
    if (!companyId) return NextResponse.json({ error: 'Company is required', code: 'company_required' }, { status: 400 });
    if (scope.session.user.role === 'COMPANY' && data.companyId && data.companyId !== companyId) {
      return NextResponse.json({ error: 'Cannot create for another company', fields: ['companyId'], code: 'protected_fields' }, { status: 403 });
    }
    const company = await prisma.company.findFirst({ where: { id: companyId, orgId: scope.orgId }, select: { id: true } });
    if (!company) return NextResponse.json({ error: 'Company not found', code: 'company_not_found' }, { status: 404 });
    if (data.ownerId && !(await validateRequisitionOwner(data.ownerId, scope.orgId, companyId))) {
      return NextResponse.json({ error: 'Owner must be an active company user in the same organization and company', code: 'invalid_owner' }, { status: 400 });
    }
    let skills: string[];
    try { skills = normalizeSkills(data.requiredSkills); }
    catch { return NextResponse.json({ error: 'A required skill is too long', code: 'invalid_required_skills' }, { status: 400 }); }
    const requisition = await prisma.requisition.create({
      data: {
        orgId: scope.orgId, companyId, title: data.title, description: data.description || null,
        status: data.status, openings: data.openings, filled: data.filled, requiredSkills: skills,
        city: data.city || null, workMode: data.workMode || null,
        startDate: data.startDate ? new Date(data.startDate) : null, ownerId: data.ownerId || null,
        closedAt: closedAtForStatus(data.status),
      },
      include: { company: { select: { id: true, name: true } }, owner: { select: { id: true, fullName: true } } },
    });
    return NextResponse.json({ requisition }, { status: 201 });
  });
}
