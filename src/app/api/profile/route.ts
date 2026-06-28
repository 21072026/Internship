import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { logActivity } from '@/lib/activity';

const updateProfileSchema = z.object({
  fullName: z.string().min(1).optional(),
  phone: z.string().optional(),
  whatsapp: z.string().optional(),
  city: z.string().optional(),
  birthDate: z.string().optional(),
  referralSource: z.string().optional(),
  university: z.string().optional(),
  department: z.string().optional(),
  graduationYear: z.number().int().nullable().optional(),
  skills: z.array(z.string()).optional(),
  cvUrl: z.string().url().or(z.literal('')).nullable().optional(),
  publicProfile: z.boolean().optional(),
});

export async function GET() {
  try {
    const session = await getServerSession(authOptions);

    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
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
        avatarUrl: true,
        publicProfile: true,
        profileViews: true,
        createdAt: true,
      },
    });

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    return NextResponse.json({ user });
  } catch (error) {
    console.error('Get profile error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const session = await getServerSession(authOptions);

    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const parsed = updateProfileSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { cvUrl, birthDate, ...rest } = parsed.data;

    const user = await prisma.user.update({
      where: { id: session.user.id },
      data: {
        ...rest,
        cvUrl: cvUrl || null,
        ...(birthDate !== undefined
          ? { birthDate: birthDate ? new Date(birthDate) : null }
          : {}),
      },
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
        publicProfile: true,
        updatedAt: true,
      },
    });

    await logActivity({ action: 'profile.update', actorId: session.user.id, actorEmail: session.user.email ?? null });
    return NextResponse.json({ user });
  } catch (error) {
    console.error('Update profile error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
