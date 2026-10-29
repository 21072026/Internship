import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { requireCapability } from '@/lib/capabilityGate';

// GET /api/mentee/offers — the signed-in MENTEE's open Mentor Offers (#1809),
// for the panel on /portal. Only their own; a mentor's profile fields only.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'MENTEE') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const denied = await requireCapability(resolveOrgId(session), 'mentorship');
  if (denied) return denied;
  return withTenantScope(session, async () => {
    const offers = await prisma.mentorOffer.findMany({
      where: { menteeId: session.user.id, status: 'PENDING', expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        message: true,
        expiresAt: true,
        createdAt: true,
        mentor: { select: { id: true, fullName: true, displayName: true, avatarUrl: true, bio: true, skills: true, publicProfile: true } },
      },
    });
    return NextResponse.json({ offers });
  });
}
