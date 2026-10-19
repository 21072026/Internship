import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { listOrgFor, listSources } from '@/lib/integrationSourceAdmin';

// GET — the registered integration sources of the caller's organization
// (#2978): slug, label, on/off, IP allowlist, whether requests must be signed
// and since when, and when the last event arrived. Never a secret. A super
// admin of the org's world may name another org with `?orgId=`; a tenant admin
// who does is refused. Rules and writes: src/lib/integrationSourceAdmin.ts.
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const gate = await listOrgFor(session, new URL(request.url).searchParams.get('orgId'));
  if (!gate.ok) return gate.response;
  return NextResponse.json({ sources: await listSources(gate.value) });
}
