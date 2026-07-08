import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { hasFeature } from '@/lib/entitlements';

// GET — premium talent-pool search for companies (Faz 1, #528). Gated by the
// TALENT_POOL_SEARCH entitlement. Privacy-safe: only surfaces mentees who have
// opted into a public profile (publicProfile=true) — the same visibility as the
// public /p/[id] page — so no mentee is exposed without their own opt-in.
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'COMPANY' && session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  // Admins can always view (support); companies need the premium entitlement.
  if (session.user.role === 'COMPANY' && !(await hasFeature(session.user.companyId, 'TALENT_POOL_SEARCH'))) {
    return NextResponse.json({ error: 'feature_locked' }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const q = (searchParams.get('q') || '').trim().slice(0, 100);
  const skill = (searchParams.get('skill') || '').trim().slice(0, 60).toLowerCase();

  const where: Record<string, unknown> = { role: 'MENTEE', isActive: true, publicProfile: true };
  if (q) {
    where.OR = [
      { fullName: { contains: q } },
      { university: { contains: q } },
      { department: { contains: q } },
      { targetPosition: { contains: q } },
      { city: { contains: q } },
    ];
  }

  const rows = await prisma.user.findMany({
    where,
    take: 60,
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true, fullName: true, university: true, department: true,
      graduationYear: true, city: true, targetPosition: true, skills: true, avatarUrl: true,
    },
  });

  // skills is a JSON array — filter in JS when a skill query is given.
  const candidates = skill
    ? rows.filter((r) => Array.isArray(r.skills) && (r.skills as string[]).some((s) => String(s).toLowerCase().includes(skill)))
    : rows;

  return NextResponse.json({ candidates });
}
