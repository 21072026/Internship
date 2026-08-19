import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import { notify } from '@/lib/notify';
import { emailAllowed } from '@/lib/notificationPrefs';
import { sendMeetingRequestDecisionEmail } from '@/services/emailService';
import { generateMeetingLink } from '@/lib/meetingRoom';

const schema = z.object({ action: z.enum(['accept', 'decline']) });

// Email the requester the outcome (#668) — previously in-app only, so a mentee
// waiting on a slot had no way to learn it was confirmed. Opt-out respected and
// failures are logged, never surfaced as a failed decision.
async function emailDecision(
  requestedById: string,
  args: { topic: string; accepted: boolean; scheduledAt?: Date | null; meetLink?: string | null; link: string }
) {
  const user = await prisma.user.findUnique({
    where: { id: requestedById },
    select: { fullName: true, email: true, orgId: true, emailNotifications: true, notificationPrefs: true, timezone: true },
  });
  if (!user?.email || !emailAllowed(user, 'meetingReminders')) return;
  try {
    await sendMeetingRequestDecisionEmail({ to: user.email, fullName: user.fullName, orgId: user.orgId, timeZone: user.timezone, ...args });
  } catch (e) {
    console.error('Meeting request decision email failed:', e);
  }
}

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
    await notify(req.requestedById, 'meeting_request.declined', {}, '/portal');
    await emailDecision(req.requestedById, { topic: req.topic, accepted: false, link: '/portal' });
    return NextResponse.json({ ok: true, status: 'DECLINED' });
  }

  // Accept → create the confirmed meeting with an auto video link. A request
  // is always mentee → mentor, so the meeting is structurally a 1:1 call.
  const link = generateMeetingLink({ inviteeCount: 1 });
  // The wall clock behind `proposedAt` was typed by the *requester* (see
  // POST /api/meeting-requests), so theirs is the zone this time was agreed on —
  // not the mentor's, even though the mentor is the one confirming it (#1210).
  const requester = await prisma.user.findUnique({
    where: { id: req.requestedById },
    select: { timezone: true },
  });
  const meeting = await prisma.meeting.create({
    data: {
      relationId: rel.id,
      title: req.topic,
      scheduledAt: req.proposedAt,
      timeZone: requester?.timezone ?? null,
      meetLink: link,
      rsvpToken: randomBytes(24).toString('hex'),
      createdById: session.user.id,
    },
  });
  await prisma.meetingRequest.update({ where: { id }, data: { status: 'ACCEPTED' } });
  await notify(req.requestedById, 'meeting_request.accepted', { topic: req.topic }, `/messages/${rel.id}`);
  await emailDecision(req.requestedById, {
    topic: req.topic,
    accepted: true,
    scheduledAt: meeting.scheduledAt,
    meetLink: meeting.meetLink,
    link: `/messages/${rel.id}`,
  });
  return NextResponse.json({ ok: true, status: 'ACCEPTED', meetingId: meeting.id });
}
