import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { resolveOrgId } from '@/lib/orgScope';
import { chatStatusFor } from '@/lib/chat/workspaces';

// GET — the chat apps' install console (#1958): per platform configured or
// not, the deployment switch, and every workspace THIS org installed (who
// installed it, the scopes granted, enabled, confirmed identities, last error,
// last delivery). Never a token — chatStatusFor() selects column by column.
// ADMIN only, on the route; the org is the session's, never a parameter.
export async function GET(request: Request) {
  const gate = await requirePermission('org.integrations.read', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const orgId = resolveOrgId(session);
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 403 });
  return NextResponse.json(await chatStatusFor(orgId));
}
