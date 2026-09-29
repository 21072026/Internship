import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { invitationOrgWhere } from '@/lib/inviteCreate';

const schema = z.object({ token: z.string().min(1) });

// POST { token } — confirm an email address and consume the token.
export async function POST(request: Request) {
  try {
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 400 });
    }

    const record = await prisma.emailVerificationToken.findUnique({ where: { token: parsed.data.token } });
    if (!record || record.used || record.expiresAt < new Date()) {
      return NextResponse.json({ error: 'This link is invalid or has expired' }, { status: 400 });
    }

    // Clicking the emailed link is what opens the door for an open sign-up:
    // the account was created inactive, and verifying proves the address is
    // really theirs. It admits itself here unless it is explicitly parked for
    // an admin (pendingApproval, set when `selfRegistration` is 'manual') or
    // was deactivated by an admin after having been active — neither of which
    // an email click may override.
    const before = await prisma.user.findUnique({
      where: { id: record.userId },
      select: { isActive: true, emailVerified: true, pendingApproval: true },
    });
    const admitNow = !!before && !before.isActive && !before.emailVerified && !before.pendingApproval;

    const [user] = await prisma.$transaction([
      prisma.user.update({
        where: { id: record.userId },
        data: { emailVerified: true, ...(admitNow ? { isActive: true } : {}) },
        select: { email: true, orgId: true },
      }),
      prisma.emailVerificationToken.update({ where: { id: record.id }, data: { used: true } }),
    ]);

    // Advance the matching invitation's lifecycle to "verified" (if any invite
    // for this email hasn't been stamped yet).
    //
    // Unscoped on purpose: this route is entered with a verification token and
    // no session, so no tenant context is bound and the middleware leaves the
    // `updateMany` alone even though `InvitationToken` is registered (#1559).
    // The address is the key, and an address belongs to one person — so do not
    // "fix" this by wrapping the handler in a tenant scope; there is no tenant
    // to resolve from a mail click.
    //
    // WORLDS (#2590): "an address belongs to one person" is still true, but one
    // person can now hold an invitation for the same address in EACH world
    // (internship org and marketing org), and confirming the mailbox for the
    // account that was verified here is not a statement about the other world's
    // invitation — its own account, its own verification link. So the stamp is
    // keyed by (address, the verified account's ORGANIZATION), never the address
    // alone: this route acts on exactly the row its token was minted for. The
    // token → userId lookup above is untouched; only this side effect was
    // address-wide. Single-org deployments: every invitation is the default
    // org's, so the same rows are stamped as before.
    await prisma.invitationToken.updateMany({
      where: { email: user.email, ...(await invitationOrgWhere(user.orgId)), verifiedAt: null },
      data: { verifiedAt: new Date() },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Verify email error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
