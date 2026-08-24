import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { randomBytes } from 'crypto';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';

// Personal ICS feed credential (#915). The token is the whole credential for
// the public feed URL, so it is generated server-side (256-bit), shown only to
// its owner, rotated by re-POSTing, and revoked by DELETE. Any signed-in role
// may hold one — the feed itself only ever serves that user's own meetings.

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { icsFeedToken: true } });
  return NextResponse.json({ token: user?.icsFeedToken ?? null });
}

// POST — create the token, or rotate it (the old URL stops working at once).
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const token = randomBytes(32).toString('hex');
  await prisma.user.update({ where: { id: session.user.id }, data: { icsFeedToken: token } });
  await logActivity({ action: 'account.ics_feed.rotate', actorId: session.user.id, actorEmail: session.user.email ?? null, request });
  return NextResponse.json({ token });
}

// DELETE — revoke: the feed URL 404s from now on.
export async function DELETE(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  await prisma.user.update({ where: { id: session.user.id }, data: { icsFeedToken: null } });
  await logActivity({ action: 'account.ics_feed.revoke', actorId: session.user.id, actorEmail: session.user.email ?? null, request });
  return NextResponse.json({ ok: true });
}
