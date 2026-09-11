import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { enforceRateLimit } from '@/lib/rateLimit';

const schema = z.object({ token: z.string().min(1) });

// POST { token } — public. Called when an invitee opens the registration link.
// Records the first open (openedAt) so admins can see the invite was clicked,
// even before the invitee finishes registering. Idempotent: only the first
// open is stamped, and used/expired invitations are ignored.
export async function POST(request: Request) {
  const limited = enforceRateLimit(request, 'invite-opened', { limit: 30, windowMs: 10 * 60 * 1000 });
  if (limited) return limited;

  const parsed = schema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid token' }, { status: 400 });

  // Looked up BY TOKEN, with no tenant context bound — and that is correct.
  // `InvitationToken` is registered in TENANT_MODELS (#1559), but this route is
  // public: there is no session, so `currentOrgId()` is undefined and the
  // middleware does not scope. It must stay that way. Wrapping this in a tenant
  // scope would narrow the lookup to an org the invitee has no way to present,
  // and the "your link was opened" signal would silently stop working. The
  // token itself is the authorisation here.
  const invite = await prisma.invitationToken.findUnique({ where: { token: parsed.data.token } });
  // Silently succeed for unknown/consumed tokens — this is a best-effort signal,
  // not an auth check, and we don't want to leak which tokens exist.
  if (invite && !invite.used && !invite.revokedAt && !invite.openedAt && invite.expiresAt > new Date()) {
    await prisma.invitationToken.update({ where: { id: invite.id }, data: { openedAt: new Date() } });
  }
  return NextResponse.json({ ok: true });
}
