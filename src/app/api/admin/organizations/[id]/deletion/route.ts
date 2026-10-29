import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requirePermission } from '@/lib/authz';
import { cancelOrgDeletion, requestOrgDeletion } from '@/lib/orgDeletion';
import { DELETION_ERRORS } from '@/lib/orgDeletionErrors';

// /api/admin/organizations/[id]/deletion (#1584, docs/tenant-lifecycle.md
// § Hard delete) — stage 1 of the permanent deletion.
//   POST   { confirmSlug } — request it (archived tenant, exact slug);
//   DELETE                 — withdraw the request.
// Super admin of the org's world only. Refused with `hard_delete_disabled`
// unless the deployment sets TENANT_HARD_DELETE_ENABLED. Stage 2 is
// DELETE /api/admin/organizations/[id].

const bodySchema = z.object({ confirmSlug: z.string().max(200) }).strict();

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requirePermission('platform.org.write', { subject: { orgId: id }, request });
  if ('error' in gate) return gate.error;
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  const r = await requestOrgDeletion(
    id,
    parsed.data.confirmSlug,
    { id: gate.actor.id, email: gate.session.user?.email ?? null, orgId: gate.actor.orgId },
    request,
  );
  if (!r.ok) {
    const e = DELETION_ERRORS[r.code];
    return NextResponse.json({ error: e.error, code: r.code }, { status: e.status });
  }
  return NextResponse.json({ deletionRequestedAt: r.deletionRequestedAt });
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requirePermission('platform.org.write', { subject: { orgId: id }, request });
  if ('error' in gate) return gate.error;
  const r = await cancelOrgDeletion(id, { id: gate.actor.id, email: gate.session.user?.email ?? null, orgId: gate.actor.orgId }, request);
  if (!r.ok) {
    const e = DELETION_ERRORS[r.code];
    return NextResponse.json({ error: e.error, code: r.code }, { status: e.status });
  }
  return NextResponse.json({ ok: true });
}
