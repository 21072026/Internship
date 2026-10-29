import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { setOrganizationArchived, type ArchiveResult } from '@/lib/orgLifecycle';

// /api/admin/organizations/[id]/archive (#1582, docs/tenant-lifecycle.md)
//   POST   — archive: every sign-in door refuses the tenant's people (with the
//            same message as a wrong password), live sessions end on their next
//            request, no mail is sent to them, and every row is kept;
//   DELETE — bring it back.
// Super admin of the org's world only (`platform.org.write`). The default org
// and the operator's own org cannot be archived (orgLifecycleRule.ts).

const ERRORS: Record<Exclude<ArchiveResult, { ok: true }>['code'], { status: number; error: string }> = {
  not_found: { status: 404, error: 'Organization not found' },
  default_org: { status: 409, error: 'The default organization cannot be archived' },
  own_org: { status: 409, error: 'You cannot archive the organization you are signed in through' },
  already_archived: { status: 409, error: 'The organization is already archived' },
  not_archived: { status: 409, error: 'The organization is not archived' },
};

async function handle(request: Request, id: string, archive: boolean) {
  const gate = await requirePermission('platform.org.write', { subject: { orgId: id }, request });
  if ('error' in gate) return gate.error;
  const result = await setOrganizationArchived(
    id,
    archive,
    { id: gate.actor.id, email: gate.session.user?.email ?? null, orgId: gate.actor.orgId },
    request,
  );
  if (!result.ok) {
    const e = ERRORS[result.code];
    return NextResponse.json({ error: e.error, code: result.code }, { status: e.status });
  }
  return NextResponse.json({ archivedAt: result.archivedAt });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(request, (await params).id, true);
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(request, (await params).id, false);
}
