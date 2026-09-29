import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { bulkMissingRequirements } from '@/lib/documentRequirements';
import { resolvePipelineStages } from '@/lib/pipelineStages';
import { getServerDictionary } from '@/i18n/server';
import { mayManageOrgRequirements } from '@/lib/documentRequirementAccess';

// Deliberately not wrapped in withTenantScope: the org is an explicit
// parameter a super admin may point at any tenant, and bulkMissingRequirements
// names `orgId` in every query. The authorisation is mayManageOrgRequirements()
// (#2542) — another tenant's org answers 404 like a missing one, before the
// lookup, so the refusal cannot confirm that the org exists.

const roleSchema = z.enum(['ADMIN', 'MENTOR', 'MENTEE', 'COMPANY', 'SOURCE']);

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const query = new URL(request.url).searchParams;
  const orgId = query.get('orgId');
  if (!orgId) return NextResponse.json({ error: 'orgId is required' }, { status: 400 });
  if (!(await mayManageOrgRequirements(session, orgId, 'GET /api/admin/documents/missing'))) {
    return NextResponse.json({ error: 'Organization not found' }, { status: 404 });
  }
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true } });
  if (!org) return NextResponse.json({ error: 'Organization not found' }, { status: 404 });
  const parsedRole = roleSchema.safeParse(query.get('role') || 'MENTEE');
  if (!parsedRole.success) return NextResponse.json({ error: 'Invalid role' }, { status: 400 });
  const stage = query.get('stage') || undefined;
  if (stage && !(await resolvePipelineStages(orgId)).some((candidate) => candidate.key === stage)) return NextResponse.json({ error: 'Invalid pipeline stage' }, { status: 400 });
  const page = Math.max(1, Number(query.get('page')) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(query.get('pageSize')) || 50));
  const { locale } = await getServerDictionary();
  const result = await bulkMissingRequirements({ orgId, role: parsedRole.data, stage, search: query.get('search') || undefined, page, pageSize, locale });
  return NextResponse.json(result);
}
