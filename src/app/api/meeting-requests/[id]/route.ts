import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import { notify } from '@/lib/notify';

const schema = z.object({ action: z.enum(['accept', 'decline']) });

// PATCH — the mentor (or admin) accepts or declines a meeting request.
// Accepting creates a confirmed Meeting (with an auto video link) and notifies
// the requester.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  const req = await prisma.meetingRequest.findUnique({ where: { id }, include: { relation: true } });
  if (!req) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const rel = req.relation;
  const allowed = session.user.role === 'ADMIN' || rel.mentorId === session.user.id;
  if (!allowed) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  if (req.status !== 'PENDING') return NextResponse.json({ error: 'Already handled' }, { status: 409 });

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

  if (parsed.data.action === 'decline') {
    await prisma.meetingRequest.update({ where: { id }, data: { status: 'DECLINED' } });
    await notify(req.requestedById, 'meeting_request', 'Your meeting request was declined.', '/portal');
    return NextResponse.json({ ok: true, status: 'DECLINED' });
  }

  // Accept → create the confirmed meeting with an auto video link.
  const link = `https://meet.jit.si/InternshipCRM-${randomBytes(8).toString('hex')}`;
  const meeting = await prisma.meeting.create({
    data: {
      relationId: rel.id,
      title: req.topic,
      scheduledAt: req.proposedAt,
      meetLink: link,
      rsvpToken: randomBytes(24).toString('hex'),
      createdById: session.user.id,
    },
  });
  await prisma.meetingRequest.update({ where: { id }, data: { status: 'ACCEPTED' } });
  await notify(req.requestedById, 'meeting_request', `Your meeting request was accepted: ${req.topic}.`, `/messages/${rel.id}`);
  return NextResponse.json({ ok: true, status: 'ACCEPTED', meetingId: meeting.id });
}
