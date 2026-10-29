import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { resolveOrgId } from '@/lib/orgScope';
import { logActivity } from '@/lib/activity';
import { IdentityError, confirmIdentity, myChatIdentities, revokeIdentity } from '@/lib/chat/identity';

// The person's own chat links (#1937): GET lists them, POST confirms one,
// DELETE removes one. Any signed-in role — a link is about the person, not a
// role. A person acts only on their OWN identity; DELETE also lets an ADMIN
// remove any link of their own org (the route decides, not the button).
// Another person's identity is 403, an unknown id 404.

const bodySchema = z.object({ identityId: z.string().min(1).max(64) }).strict();
const STATUS = { not_found: 404, forbidden: 403 } as const;

async function body(request: Request) {
  return bodySchema.safeParse(await request.json().catch(() => null));
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return NextResponse.json({ items: await myChatIdentities(session.user.id) });
}

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const parsed = await body(request);
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  try {
    await confirmIdentity(session.user.id, parsed.data.identityId);
  } catch (e) {
    if (e instanceof IdentityError) return NextResponse.json({ error: e.code }, { status: STATUS[e.code as keyof typeof STATUS] ?? 400 });
    throw e;
  }
  await logActivity({
    action: 'chat.identity_confirmed',
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    targetType: 'user',
    targetId: session.user.id,
    request,
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const parsed = await body(request);
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  const adminOrgId = session.user.role === 'ADMIN' ? resolveOrgId(session) : null;
  try {
    await revokeIdentity({ userId: session.user.id, adminOrgId }, parsed.data.identityId);
  } catch (e) {
    if (e instanceof IdentityError) return NextResponse.json({ error: e.code }, { status: STATUS[e.code as keyof typeof STATUS] ?? 400 });
    throw e;
  }
  await logActivity({
    action: 'chat.identity_revoked',
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    targetType: 'chat_identity',
    targetId: parsed.data.identityId,
    request,
  });
  return NextResponse.json({ ok: true });
}
