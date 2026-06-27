import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import crypto from 'crypto';
import { z } from 'zod';

const schema = z.object({
  fullName: z.string().min(1),
  email: z.string().email().optional().or(z.literal('')),
  phone: z.string().optional(),
  whatsapp: z.string().optional(),
  city: z.string().optional(),
  university: z.string().optional(),
  department: z.string().optional(),
  referralSource: z.string().optional(),
});

const slug = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '');

// A mentor (or admin) creates a mentee and assigns it to themselves in one step.
export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session || (session.user.role !== 'MENTOR' && session.user.role !== 'ADMIN')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
    }
    const { fullName, email, ...rest } = parsed.data;

    // Use the given email, or a deterministic placeholder for non-login tracked mentees.
    const finalEmail =
      email && email.length > 0
        ? email
        : `mentee.${slug(fullName)}.${crypto.randomBytes(2).toString('hex')}@import.local`;

    const existing = await prisma.user.findUnique({ where: { email: finalEmail } });
    if (existing) {
      return NextResponse.json({ error: 'A user with this email already exists' }, { status: 409 });
    }

    const mentee = await prisma.user.create({
      data: {
        email: finalEmail,
        password: '!created-no-login',
        role: 'MENTEE',
        fullName,
        skills: [],
        phone: rest.phone || null,
        whatsapp: rest.whatsapp || null,
        city: rest.city || null,
        university: rest.university || null,
        department: rest.department || null,
        referralSource: rest.referralSource || null,
      },
    });

    await prisma.mentorshipRelation.create({
      data: { mentorId: session.user.id, menteeId: mentee.id },
    });

    return NextResponse.json({ menteeId: mentee.id }, { status: 201 });
  } catch (error) {
    console.error('Create mentee error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
