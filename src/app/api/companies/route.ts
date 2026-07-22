import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { withTenantScope } from '@/lib/orgContext';

const companySchema = z.object({
  name: z.string().min(1, 'Company name is required'),
  description: z.string().optional(),
  contactEmail: z.string().email('Invalid contact email').optional().or(z.literal('')),
  industry: z.string().optional(),
  logoUrl: z.string().url().or(z.literal('')).optional(),
  size: z.string().max(40).optional(),
  address: z.string().max(300).optional(),
  quota: z.number().int().min(0).max(10000).nullable().optional(),
  needs: z
    .array(
      z.object({
        position: z.string().min(1),
        count: z.number().int().min(1),
        period: z.string().min(1),
      })
    )
    .optional(),
});

export async function GET() {
  try {
    const session = await getServerSession(authOptions);

    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    return await withTenantScope(session, async () => {
      const companies = await prisma.company.findMany({
        include: {
          needs: true,
          _count: { select: { mentorships: true } },
        },
        orderBy: { name: 'asc' },
      });

      return NextResponse.json({ companies });
    });
  } catch (error) {
    console.error('Get companies error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);

    if (!session || session.user.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    return await withTenantScope(session, async () => {
    const body = await request.json();
    const parsed = companySchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { needs, contactEmail, ...companyData } = parsed.data;

    const company = await prisma.company.create({
      data: {
        ...companyData,
        contactEmail: contactEmail || null,
        needs: needs
          ? {
              create: needs,
            }
          : undefined,
      },
      include: { needs: true },
    });

    return NextResponse.json({ company }, { status: 201 });
    });
  } catch (error) {
    console.error('Create company error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
