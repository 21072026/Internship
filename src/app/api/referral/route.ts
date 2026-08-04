import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { ensureReferralCode, referralUrl } from '@/lib/referral';

// GET — my shareable referral link, plus who has already signed up through it
// (#51). Anyone signed in has one: mentees invite their circle, mentors and
// admins use the same mechanism, and whoever arrives is credited to them.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  return await withTenantScope(session, async () => {
    const code = await ensureReferralCode(session.user.id);
    // The account vanished between rendering the page and this request.
    if (!code) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const referred = await prisma.user.findMany({
      where: { referredById: session.user.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, fullName: true, role: true, isActive: true, createdAt: true },
    });
    return NextResponse.json({ code, url: referralUrl(code), referred, count: referred.length });
  });
}
