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
        sourceId: true,
        source: { select: { id: true, name: true } },
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
            project: { select: { id: true, name: true } },
            cohort: { select: { id: true, name: true } },
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

// PATCH — admin updates a user's account flags (currently: active/inactive).
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await getServerSession(authOptions);
    if (!session || session.user.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const data: { isActive?: boolean; sourceId?: string | null } = {};

    if (typeof body.isActive === 'boolean') {
      // Guard against an admin locking themselves out.
      if (id === session.user.id && body.isActive === false) {
        return NextResponse.json({ error: 'You cannot deactivate your own account' }, { status: 400 });
      }
      data.isActive = body.isActive;
    }

    // Assign / clear the mentee's referral source.
    if ('sourceId' in body && (typeof body.sourceId === 'string' || body.sourceId === null)) {
      data.sourceId = body.sourceId || null;
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: 'No supported fields to update' }, { status: 400 });
    }

    const user = await prisma.user.update({
      where: { id },
      data,
      select: { id: true, isActive: true, sourceId: true },
    });

    return NextResponse.json({ user });
  } catch (error) {
    console.error('Update user error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
