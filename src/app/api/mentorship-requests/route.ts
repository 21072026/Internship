import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { notify } from '@/lib/notify';

// Mentee-side mentorship requests (#590): a mentee asks for a mentor; an admin
// approves (creating the MentorshipRelation) or rejects via the admin queue.

const createSchema = z.object({
  message: z.string().max(1000).optional(),
  targetPosition: z.string().max(120).optional(),
});

// GET — the caller's own requests, newest first.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'MENTEE') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const requests = await prisma.mentorshipRequest.findMany({
    where: { menteeId: session.user.id },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: { id: true, status: true, message: true, targetPosition: true, createdAt: true, decidedAt: true },
  });
  return NextResponse.json({ requests });
}

// POST — create a request. Guards: one PENDING at a time, no request while a
// mentorship is already active, and a 1h cooldown between submissions (spam).
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'MENTEE') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const parsed = createSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });

  const [activeRelation, pending, latest] = await Promise.all([
    prisma.mentorshipRelation.findFirst({ where: { menteeId: session.user.id, status: 'ACTIVE' }, select: { id: true } }),
    prisma.mentorshipRequest.findFirst({ where: { menteeId: session.user.id, status: 'PENDING' }, select: { id: true } }),
    prisma.mentorshipRequest.findFirst({ where: { menteeId: session.user.id }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
  ]);
  if (activeRelation) {
    return NextResponse.json({ error: 'You already have an active mentorship', code: 'already_mentored' }, { status: 409 });
  }
  if (pending) {
    return NextResponse.json({ error: 'You already have a pending request', code: 'already_pending' }, { status: 409 });
  }
  if (latest && Date.now() - latest.createdAt.getTime() < 60 * 60 * 1000) {
    return NextResponse.json({ error: 'Please wait before submitting another request', code: 'rate_limited' }, { status: 429 });
  }

  const created = await prisma.mentorshipRequest.create({
    data: {
      menteeId: session.user.id,
      message: parsed.data.message?.trim() || null,
      targetPosition: parsed.data.targetPosition?.trim() || null,
    },
    select: { id: true, status: true, createdAt: true },
  });

  const admins = await prisma.user.findMany({ where: { role: 'ADMIN', isActive: true }, select: { id: true } });
  await Promise.all(
    admins.map((a) => notify(a.id, 'mentorship_request', `New mentorship request from ${session.user.name ?? 'a mentee'}.`, '/admin/mentorship'))
  );

  return NextResponse.json({ request: created }, { status: 201 });
}
