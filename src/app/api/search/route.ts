import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import type { Prisma } from '@prisma/client';

// GET ?q= — global search over users (by name/email) and companies (by name).
// Admins search everyone; mentors search their own mentees.
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== 'ADMIN' && session.user.role !== 'MENTOR')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return await withTenantScope(session, async () => {
    const q = (new URL(request.url).searchParams.get('q') || '').trim();
    if (q.length < 2) return NextResponse.json({ users: [], companies: [] });

    const userWhere: Prisma.UserWhereInput = {
      OR: [{ fullName: { contains: q } }, { email: { contains: q } }],
    };
    if (session.user.role === 'MENTOR') {
      userWhere.role = 'MENTEE';
      userWhere.menteeRelations = { some: { mentorId: session.user.id } };
    }

    const [users, companies] = await Promise.all([
      prisma.user.findMany({
        where: userWhere,
        select: { id: true, fullName: true, email: true, role: true },
        take: 8,
        orderBy: { fullName: 'asc' },
      }),
      session.user.role === 'ADMIN'
        ? prisma.company.findMany({ where: { name: { contains: q } }, select: { id: true, name: true }, take: 5 })
        : Promise.resolve([]),
    ]);

    return NextResponse.json({ users, companies });
  });
}
