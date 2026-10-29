import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { resolveOrgId } from '@/lib/orgScope';
import { CHAT_LEDGER_MAX, listChatDeliveries } from '@/lib/chat/workspaces';

// GET ?workspaceId=…&limit=50 — the chat delivery ledger (#1960): the newest
// attempts of one workspace of the caller's org, so "I never got the message"
// is answered without server access. Event key, recipient name, outcome and
// reason only — never the card body, never a token. ADMIN only, on the route;
// a workspace of another org is 404.
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const orgId = resolveOrgId(session);
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 403 });
  const sp = new URL(request.url).searchParams;
  const workspaceId = sp.get('workspaceId')?.trim();
  if (!workspaceId) return NextResponse.json({ error: 'workspaceId required' }, { status: 400 });
  const items = await listChatDeliveries(orgId, workspaceId, Number(sp.get('limit')) || CHAT_LEDGER_MAX);
  if (!items) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ items });
}
