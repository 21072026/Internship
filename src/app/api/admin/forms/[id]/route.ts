import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { archiveFormDefinition, FormWriteError, saveFormDefinition, updateFormSchema } from '@/lib/forms/definitions';
import { requirePermission } from '@/lib/authz';

// One version of an admin-defined form (#1800).
//   GET    — the version with its fields
//   PUT    — save an edit: a draft in place, a published version as N+1
//            (201 + `newVersion: true`); a re-keyed or re-typed field is a 409
//   DELETE — retire the form (every version stops being asked; answers stay)
// Another tenant's form answers like a missing one.

async function findForm(session: Parameters<typeof tenantWhere>[0], id: string) {
  return prisma.formDefinition.findFirst({
    where: withinTenant({ id }, await tenantWhere(session)),
    include: { fields: { orderBy: { sortOrder: 'asc' } } },
  });
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission('content.read', { request: _request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  return withTenantScope(session, async () => {
    const form = await findForm(session, (await params).id);
    if (!form) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ form });
  });
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission('content.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const parsed = updateFormSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input', code: 'invalid', issues: parsed.error.issues }, { status: 400 });
  return withTenantScope(session, async () => {
    const existing = await findForm(session, (await params).id);
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    try {
      const { form, newVersion } = await saveFormDefinition(existing.id, parsed.data);
      return NextResponse.json({ form, newVersion }, { status: newVersion ? 201 : 200 });
    } catch (error) {
      if (error instanceof FormWriteError) return NextResponse.json({ error: error.code, code: error.code, ...error.detail }, { status: error.status });
      throw error;
    }
  });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission('content.write', { request: _request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  return withTenantScope(session, async () => {
    const existing = await findForm(session, (await params).id);
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    await archiveFormDefinition(existing.id);
    return NextResponse.json({ ok: true });
  });
}
