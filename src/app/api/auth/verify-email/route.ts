import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';

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
        select: { email: true },
      }),
      prisma.emailVerificationToken.update({ where: { id: record.id }, data: { used: true } }),
    ]);

    // Advance the matching invitation's lifecycle to "verified" (if any invite
    // for this email hasn't been stamped yet).
    await prisma.invitationToken.updateMany({
      where: { email: user.email, verifiedAt: null },
      data: { verifiedAt: new Date() },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Verify email error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
