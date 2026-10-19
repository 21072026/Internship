import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { disableSigning, rotateSigningSecret, sourceFor } from '@/lib/integrationSourceAdmin';

// The request-signing secret of one registered integration source (#2978).
//
// POST generates it, or rotates it: the new secret is in THIS response and in
// no later one (it is sealed at rest and never listed); the secret it replaces
// keeps verifying for SIGNING_SECRET_OVERLAP_MS so a running sender is not cut
// off before it is redeployed. DELETE switches signing off at once.
//
// The ADMIN of the source's org or a super admin of its world; another org's
// source is the same 404 as a missing one; an AuditLog row with the source's
// orgId for each change, never the secret.
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const gate = await sourceFor(session, (await params).id);
  if (!gate.ok) return gate.response;
  const { secret, source } = await rotateSigningSecret(session, gate.value);
  return NextResponse.json({ secret, source }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const gate = await sourceFor(session, (await params).id);
  if (!gate.ok) return gate.response;
  return NextResponse.json({ source: await disableSigning(session, gate.value) });
}
