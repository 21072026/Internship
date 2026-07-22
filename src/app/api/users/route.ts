import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';

export async function GET() {
  try {
    const session = await getServerSession(authOptions);

    if (!session || (session.user.role !== 'ADMIN' && session.user.role !== 'MENTOR')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    return await withTenantScope(session, async () => {
      // Mentors get a minimal, PII-free directory of active mentors/admins —
      // just enough for the project owner/member picker (#618).
      if (session.user.role === 'MENTOR') {
        const users = await prisma.user.findMany({
          where: { role: { in: ['MENTOR', 'ADMIN'] }, isActive: true },
          select: { id: true, fullName: true, role: true },
          orderBy: { fullName: 'asc' },
        });
        return NextResponse.json({ users });
      }

      const users = await prisma.user.findMany({
        select: {
          id: true,
          email: true,
          fullName: true,
          role: true,
          university: true,
          department: true,
          graduationYear: true,
          skills: true,
          mentorCapacity: true,
          phone: true,
          isActive: true,
          emailVerified: true,
          createdAt: true,
          _count: { select: { mentorRelations: true } },
        },
        orderBy: { createdAt: 'desc' },
      });

      return NextResponse.json({ users });
    });
  } catch (error) {
    console.error('Get users error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
