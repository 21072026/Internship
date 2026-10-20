import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { createFormDefinition, createFormSchema, FormWriteError } from '@/lib/forms/definitions';

// Admin-defined forms (#1800): list every version and create version 1. The
// rules live in src/lib/forms/definitions.ts; the builder screen is #1802.

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  return withTenantScope(session, async () => {
    const forms = await prisma.formDefinition.findMany({
      where: withinTenant({}, await tenantWhere(session)),
      orderBy: [{ key: 'asc' }, { version: 'desc' }],
      select: { id: true, key: true, audience: true, surface: true, version: true, title: true, publishedAt: true, archivedAt: true, updatedAt: true, _count: { select: { fields: true, responses: true } } },
    });
    return NextResponse.json({ forms });
  });
}

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const parsed = createFormSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input', code: 'invalid', issues: parsed.error.issues }, { status: 400 });
  return withTenantScope(session, async () => {
    try {
      const form = await createFormDefinition(resolveOrgId(session), parsed.data);
      return NextResponse.json({ form }, { status: 201 });
    } catch (error) {
      if (error instanceof FormWriteError) return NextResponse.json({ error: error.code, code: error.code, ...error.detail }, { status: error.status });
      throw error;
    }
  });
}
