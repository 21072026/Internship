import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';

const bodySchema = z.object({
  menteeId: z.string().min(1),
  status: z.enum(['INTERESTED', 'SHORTLISTED', 'PASS']),
  note: z.string().max(1000).optional(),
});

// GET ?menteeId=... — the requester company's current interest on one candidate.
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'COMPANY' || !session.user.companyId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const menteeId = new URL(request.url).searchParams.get('menteeId');
  if (!menteeId) return NextResponse.json({ error: 'menteeId is required' }, { status: 400 });

  const interest = await prisma.companyInterest.findUnique({
    where: { companyId_menteeId: { companyId: session.user.companyId, menteeId } },
  });
  return NextResponse.json({ interest });
}

// POST — set (create or update) the requester company's interest on a
// candidate they have a mentorship relation with (EPIC: company shortlist).
// Notifies the mentor of that relation so the signal reaches the org.
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'COMPANY' || !session.user.companyId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  const { menteeId, status, note } = parsed.data;

  const relation = await prisma.mentorshipRelation.findFirst({
    where: { companyId: session.user.companyId, menteeId },
    select: { mentorId: true, mentee: { select: { fullName: true } } },
  });
  if (!relation) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const company = await prisma.company.findUnique({ where: { id: session.user.companyId }, select: { name: true } });

  const interest = await prisma.companyInterest.upsert({
    where: { companyId_menteeId: { companyId: session.user.companyId, menteeId } },
    create: { companyId: session.user.companyId, menteeId, status, note },
    update: { status, note },
  });

  const STATUS_TEXT: Record<string, string> = {
    INTERESTED: 'is interested in',
    SHORTLISTED: 'shortlisted',
    PASS: 'passed on',
  };
  await prisma.notification.create({
    data: {
      userId: relation.mentorId,
      type: 'company_interest',
      text: `${company?.name ?? 'A company'} ${STATUS_TEXT[status]} ${relation.mentee.fullName}.`,
    },
  });

  await logActivity({
    action: 'company.interest.set',
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    targetType: 'user',
    targetId: menteeId,
  });

  return NextResponse.json({ interest });
}
