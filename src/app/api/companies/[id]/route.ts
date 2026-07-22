import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { z } from 'zod';

const updateCompanySchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  contactEmail: z.string().email().optional().or(z.literal('')),
  industry: z.string().optional(),
  logoUrl: z.string().url().or(z.literal('')).optional(),
  size: z.string().max(40).optional(),
  address: z.string().max(300).optional(),
  quota: z.number().int().min(0).max(10000).nullable().optional(),
  needs: z
    .array(
      z.object({
        id: z.string().optional(),
        position: z.string().min(1),
        count: z.number().int().min(1),
        period: z.string().min(1),
      })
    )
    .optional(),
});

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await getServerSession(authOptions);

    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    return await withTenantScope(session, async () => {
    const company = await prisma.company.findUnique({
      where: { id },
      include: {
        needs: true,
        mentorships: {
          include: {
            mentor: { select: { id: true, fullName: true, email: true } },
            mentee: { select: { id: true, fullName: true, email: true } },
          },
        },
      },
    });

    if (!company) {
      return NextResponse.json({ error: 'Company not found' }, { status: 404 });
    }

    return NextResponse.json({ company });
    });
  } catch (error) {
    console.error('Get company error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await getServerSession(authOptions);

    if (!session || session.user.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    return await withTenantScope(session, async () => {
    const body = await request.json();
    const parsed = updateCompanySchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { needs, contactEmail, ...companyData } = parsed.data;

    const company = await prisma.$transaction(async (tx) => {
      if (needs !== undefined) {
        await tx.companyNeed.deleteMany({ where: { companyId: id } });
      }

      return tx.company.update({
        where: { id },
        data: {
          ...companyData,
          contactEmail: contactEmail || null,
          ...(needs !== undefined && {
            needs: { create: needs.map(({ id: _id, ...n }) => n) },
          }),
        },
        include: { needs: true },
      });
    });

    return NextResponse.json({ company });
    });
  } catch (error) {
    console.error('Update company error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await getServerSession(authOptions);

    if (!session || session.user.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    return await withTenantScope(session, async () => {
    await prisma.company.delete({ where: { id } });

    return NextResponse.json({ message: 'Company deleted successfully' });
    });
  } catch (error) {
    console.error('Delete company error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
