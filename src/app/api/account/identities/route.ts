import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { canUnlinkIdentity } from '@/lib/socialProvidersRule';
import { enabledSocialProviders, hasUsablePassword } from '@/lib/socialSignIn';

// The signed-in person's own social sign-in identities (#1962): listed and
// unlinkable on /account, next to the remembered devices. Never someone
// else's — every query is keyed on the session's own user id — and the
// provider's subject is never returned (it is the credential's half the
// person does not need to see).
//
// THE GUARD: the last way in stays. An account without a usable password keeps
// at least one identity (canUnlinkIdentity) — removing it would leave an
// account nobody can sign in to.

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const [identities, user] = await Promise.all([
    prisma.userIdentity.findMany({
      where: { userId: session.user.id },
      orderBy: { createdAt: 'asc' },
      select: { id: true, provider: true, email: true, createdAt: true, lastUsedAt: true },
    }),
    prisma.user.findUnique({ where: { id: session.user.id }, select: { password: true } }),
  ]);
  return NextResponse.json({
    identities,
    hasPassword: hasUsablePassword(user?.password),
    // What "Connect" may offer: the configured providers, by id and label only.
    providers: enabledSocialProviders().map((p) => ({ id: p.id, label: p.label })),
  });
}

export async function DELETE(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  // A way into the account is the account holder's own decision.
  if (session.user.impersonatorId) {
    return NextResponse.json({ error: 'Cannot change account credentials while impersonating' }, { status: 400 });
  }
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });
  const [identity, count, user] = await Promise.all([
    prisma.userIdentity.findFirst({ where: { id, userId: session.user.id }, select: { id: true, provider: true } }),
    prisma.userIdentity.count({ where: { userId: session.user.id } }),
    prisma.user.findUnique({ where: { id: session.user.id }, select: { password: true } }),
  ]);
  if (!identity) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!canUnlinkIdentity(hasUsablePassword(user?.password), count)) {
    return NextResponse.json({ error: 'This is your last way to sign in', code: 'last_sign_in_method' }, { status: 409 });
  }
  await prisma.userIdentity.deleteMany({ where: { id: identity.id, userId: session.user.id } });
  await logActivity({ action: 'auth.identity_unlinked', level: 'warning', actorId: session.user.id, actorEmail: session.user.email ?? null, targetType: 'user', targetId: session.user.id, detail: identity.provider, request });
  return NextResponse.json({ ok: true });
}
