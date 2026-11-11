import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { enforceRateLimit } from '@/lib/rateLimit';
import { hostVertical } from '@/lib/hostVertical';
import { worldOfOrg } from '@/lib/userWorld';

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
  // An invitation of the other world opened on this host is not "opened": the
  // register route refuses it here, so it must not look clicked to its admin.
  const live =
    !!invite &&
    !invite.used &&
    !invite.revokedAt &&
    invite.expiresAt > new Date() &&
    (await worldOfOrg(invite.orgId)) === (await hostVertical());
  if (live && !invite.openedAt) {
    await prisma.invitationToken.update({ where: { id: invite.id }, data: { openedAt: new Date() } });
  }
  // WCAG 3.3.7 Redundant Entry (#2864): the invitation already names the
  // address the account must be registered with, so the form is pre-filled
  // with it instead of asking the invitee to type it again. Only for a live
  // invitation of this world, and only to the holder of the token — the same
  // secret the invitation mail delivered to that address. A dead or unknown
  // token answers exactly as before.
  return NextResponse.json(live && invite.email ? { ok: true, email: invite.email } : { ok: true });
}
