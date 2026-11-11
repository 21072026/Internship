import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requirePermission } from '@/lib/authz';
import { executeOrgDeletion } from '@/lib/orgDeletion';
import { DELETION_ERRORS } from '@/lib/orgDeletionErrors';

// DELETE /api/admin/organizations/[id] (#1584, docs/tenant-lifecycle.md
// § Hard delete) — stage 2: PERMANENTLY delete a tenant whose deletion was
// requested at least TENANT_HARD_DELETE_WAIT_HOURS ago, which is archived,
// was exported since the request, and only with the exact slug and the
// operator's own password. Off unless the deployment sets
// TENANT_HARD_DELETE_ENABLED. Super admin of the org's world only; never the
// default org, never the operator's own. Not undoable.

export const maxDuration = 600;

const bodySchema = z.object({ confirmSlug: z.string().max(200), password: z.string().min(1).max(500) }).strict();

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requirePermission('platform.org.write', { subject: { orgId: id }, request });
  if ('error' in gate) return gate.error;
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  const r = await executeOrgDeletion(
    id,
    parsed.data,
    { id: gate.actor.id, email: gate.session.user?.email ?? null, orgId: gate.actor.orgId },
    request,
  );
  if (!r.ok) {
    const e = DELETION_ERRORS[r.code];
    return NextResponse.json({ error: e.error, code: r.code }, { status: e.status });
  }
  return NextResponse.json({ deleted: r.result.deleted, nulled: r.result.nulled });
}
