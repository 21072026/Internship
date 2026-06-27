import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await getServerSession(authOptions);
    if (!session || session.user.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        phone: true,
        whatsapp: true,
        city: true,
        birthDate: true,
        referralSource: true,
        university: true,
        department: true,
        graduationYear: true,
        skills: true,
        cvUrl: true,
        createdAt: true,
        menteeRelations: {
          orderBy: { startDate: 'desc' },
          include: {
            mentor: { select: { fullName: true, email: true } },
            company: { select: { name: true, industry: true } },
            interactions: { orderBy: { date: 'desc' } },
            statusChanges: {
              orderBy: { createdAt: 'desc' },
              include: { changedBy: { select: { fullName: true } } },
            },
          },
        },
      },
    });

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    return NextResponse.json({ user });
  } catch (error) {
    console.error('Get user error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
