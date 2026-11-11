import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { resolveOrgId } from '@/lib/orgScope';
import { IdentityError, proposeIdentitiesForWorkspace } from '@/lib/chat/identity';

// POST — "Find people" on a workspace of the console (#1937): read the
// workspace's directory and PROPOSE a link for every member whose
// platform-verified address belongs to a verified account of this org.
// Proposals deliver nothing until each person confirms on their own account
// page; no member ever becomes a user. `org.integrations.write`; another org's
// workspace is 404.
const STATUS: Record<string, number> = { not_found: 404, not_supported: 409, no_token: 409, platform_error: 502 };

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission('org.integrations.write', { request });
  if ('error' in gate) return gate.error;
  const orgId = resolveOrgId(gate.session);
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 403 });
  try {
    return NextResponse.json(await proposeIdentitiesForWorkspace(orgId, (await params).id));
  } catch (e) {
    if (e instanceof IdentityError) return NextResponse.json({ error: e.code, code: e.code }, { status: STATUS[e.code] ?? 400 });
    throw e;
  }
}
