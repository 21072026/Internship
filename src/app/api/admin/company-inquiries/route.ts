import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { logActivity } from '@/lib/activity';

// Admin view of the enquiries left on /for-companies (#1104). Read + a status
// change; the reply itself happens by email (the notification mail is sent with
// the company's address as Reply-To).
const STATUSES = ['NEW', 'CONTACTED', 'CLOSED'] as const;

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return await withTenantScope(session, async () => {
    const status = new URL(request.url).searchParams.get('status');
    const where = status && (STATUSES as readonly string[]).includes(status)
      ? { status: status as (typeof STATUSES)[number] }
      : {};

    const items = await prisma.companyInquiry.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true, companyName: true, contactName: true, email: true, phone: true,
        openRoles: true, message: true, status: true, createdAt: true, handledAt: true,
        handledBy: { select: { fullName: true } },
      },
    });
    const newCount = await prisma.companyInquiry.count({ where: { status: 'NEW' } });
    return NextResponse.json({ items, newCount });
  });
}

const patchSchema = z.object({
  id: z.string().min(1),
  status: z.enum(STATUSES),
});

export async function PATCH(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

  return await withTenantScope(session, async () => {
    const existing = await prisma.companyInquiry.findUnique({ where: { id: parsed.data.id }, select: { id: true } });
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const inquiry = await prisma.companyInquiry.update({
      where: { id: parsed.data.id },
      data: {
        status: parsed.data.status,
        // "Who picked this up, and when" — the point of the list is that an
        // enquiry cannot sit unanswered without anyone noticing.
        handledAt: parsed.data.status === 'NEW' ? null : new Date(),
        handledById: parsed.data.status === 'NEW' ? null : session.user.id,
      },
      select: { id: true, status: true },
    });
    await logActivity({
      action: 'company_inquiry.status',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
    });
    return NextResponse.json({ inquiry });
  });
}
