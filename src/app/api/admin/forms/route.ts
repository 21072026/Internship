import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { defaultOrgId } from '@/lib/defaultOrg';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { createFormDefinition, createFormSchema, FormWriteError } from '@/lib/forms/definitions';
import { requirePermission } from '@/lib/authz';

// Admin-defined forms (#1800): list every version and create version 1. The
// rules live in src/lib/forms/definitions.ts; the builder screen is #1802.

export async function GET(request: Request) {
  const gate = await requirePermission('content.read', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
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
  const gate = await requirePermission('content.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const parsed = createFormSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input', code: 'invalid', issues: parsed.error.issues }, { status: 400 });
  return withTenantScope(session, async () => {
    try {
      // Never a NULL org: the deploy's backfill-organization.mjs would move it into
      // the default org and collide on @@unique([orgId, key, version]).
      const form = await createFormDefinition(resolveOrgId(session) ?? (await defaultOrgId()), parsed.data);
      return NextResponse.json({ form }, { status: 201 });
    } catch (error) {
      if (error instanceof FormWriteError) return NextResponse.json({ error: error.code, code: error.code, ...error.detail }, { status: error.status });
      throw error;
    }
  });
}
