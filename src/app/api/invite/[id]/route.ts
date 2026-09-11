import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { sendInvitationEmail } from '@/services/emailService';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';

// Admins manage every invitation; everyone else only the ones they sent — the
// same split the GET list uses, now that mentors can invite from their own page
// (#670) and need to extend or cancel their own links.
//
// Both handlers run inside withTenantScope (#1559). `InvitationToken` is
// registered in TENANT_MODELS, so with isolation on the lookups below — which
// address the row by id, the id an admin of ANY tenant could guess or be handed
// — are narrowed to the caller's own org and a foreign invitation reads as "not
// found" instead of being resent or cancelled. Behaviour-neutral with the flag
// off: `withTenantScope` is a passthrough, and `mayManage` is unchanged.
const mayManage = (
  session: { user: { id: string; role: string } },
  invite: { invitedById: string | null }
) => session.user.role === 'ADMIN' || invite.invitedById === session.user.id;

// POST — resend an invitation. Re-emails the link; if the token has expired it
// is extended by 7 days. Used (accepted) invitations cannot be resent. For an
// email-less link (#670) there is nothing to re-email, so this is purely "give
// me another week" — the refreshed URL comes back in the response either way.
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  return await withTenantScope(session, async () => {
    const { id } = await params;

    const invite = await prisma.invitationToken.findUnique({ where: { id } });
    if (!invite) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (!mayManage(session, invite)) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
    if (invite.used) return NextResponse.json({ error: 'This invitation was already accepted' }, { status: 409 });
    // A revoked invitation (#2071) is unusable: extending its expiry or re-mailing
    // its link would hand out a token registration is going to refuse.
    if (invite.revokedAt) return NextResponse.json({ error: 'This invitation was revoked' }, { status: 409 });

    // Refresh the expiry so a resent invite is always valid for another week.
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);
    await prisma.invitationToken.update({ where: { id }, data: { expiresAt } });

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    const registerUrl = `${appUrl}/auth/register?token=${invite.token}`;
    let emailSent = false;
    if (invite.email) {
      try {
        // Same single source of truth as POST /api/invite (#1431), and the same
        // language as the FIRST mail (#1720): the choice was stored on the row at
        // creation time precisely so a resend — often by a different admin than
        // the inviter — does not switch language mid-conversation.
        emailSent = (await sendInvitationEmail({
          to: invite.email,
          token: invite.token,
          role: invite.role,
          orgId: resolveOrgId(session),
          locale: invite.locale,
        })) === 'SENT';
      } catch (e) {
        console.error('Resend invitation email failed (token still valid):', e);
      }
    }
    return NextResponse.json({ ok: true, registerUrl, emailSent });
  });
}

// DELETE — cancel a pending invitation.
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  return await withTenantScope(session, async () => {
    const { id } = await params;
    const invite = await prisma.invitationToken.findUnique({ where: { id }, select: { invitedById: true } });
    if (!invite) return NextResponse.json({ ok: true });
    if (!mayManage(session, invite)) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
    await prisma.invitationToken.delete({ where: { id } }).catch(() => null);
    return NextResponse.json({ ok: true });
  });
}
