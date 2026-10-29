import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { resolveOrgId } from '@/lib/orgScope';
import { chatStatusFor } from '@/lib/chat/workspaces';

// GET — the chat apps' install console (#1958): per platform configured or
// not, the deployment switch, and every workspace THIS org installed (who
// installed it, the scopes granted, enabled, confirmed identities, last error,
// last delivery). Never a token — chatStatusFor() selects column by column.
// ADMIN only, on the route; the org is the session's, never a parameter.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const orgId = resolveOrgId(session);
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 403 });
  return NextResponse.json(await chatStatusFor(orgId));
}
