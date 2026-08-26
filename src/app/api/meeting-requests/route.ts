import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { getThreadIfAllowed, otherParticipant } from '@/lib/messaging';
import { notify } from '@/lib/notify';
import { emailAllowed } from '@/lib/notificationPrefs';
import { sendMeetingRequestEmail } from '@/services/emailService';
import { parseUserDateTime } from '@/lib/timezone';

// GET ?relationId= — meeting requests for a thread (participants/admin).
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const relationId = new URL(request.url).searchParams.get('relationId') || '';
  const rel = await getThreadIfAllowed(session.user, relationId);
  if (!rel) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const requests = await prisma.meetingRequest.findMany({ where: { relationId }, orderBy: { createdAt: 'desc' } });
  return NextResponse.json({ requests });
}

const schema = z.object({
  relationId: z.string().min(1),
  topic: z.string().min(1).max(300),
  proposedAt: z.string().min(1),
});

// POST — a participant (typically the mentee) requests a meeting.
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

  const rel = await getThreadIfAllowed(session.user, parsed.data.relationId);
  if (!rel) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  // The panel sends a zone-qualified instant; a bare wall clock is anchored to
  // the requester's zone rather than the container's UTC (#1061).
  // Loaded unconditionally since #1210: the zone is needed for the mentor's
  // email even when the instant arrived fully qualified and needed no anchoring.
  const requester = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { timezone: true },
  });
  const proposedAt = parseUserDateTime(parsed.data.proposedAt, requester?.timezone);
  if (!proposedAt) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

  const req = await prisma.meetingRequest.create({
    data: {
      relationId: rel.id,
      requestedById: session.user.id,
      topic: parsed.data.topic,
      proposedAt,
    },
  });

  // Notify the other party (the mentor) of the request.
  const recipient = otherParticipant(rel, session.user.id);
  if (recipient && recipient !== session.user.id) {
    const link = recipient === rel.mentorId ? `/mentor/mentees/${rel.id}` : '/portal';
    const requesterName = session.user.name;
    await notify(
      recipient,
      requesterName ? 'meeting_request.new' : 'meeting_request.newGeneric',
      requesterName ? { from: requesterName } : {},
      link
    );

    // Email it too (#668) — a request the mentor never sees is a request that
    // never gets answered. Opt-out respected, failures logged.
    const rcpt = await prisma.user.findUnique({
      where: { id: recipient },
      select: { fullName: true, email: true, orgId: true, emailNotifications: true, notificationPrefs: true, timezone: true },
    });
    // Deliberately NOT extended with an `emailGroupAllowedForCategory` conjunct.
    // The legacy key this check reads is `meetingReminders`, but the mail is a
    // meeting *request* (group meeting_invites), and adding the reminders
    // conjunct would let an opt-out from automated nagging silently swallow a
    // named person asking you to attend something. The group that does apply is
    // enforced centrally in sendEmail() from the category.
    if (rcpt?.email && emailAllowed(rcpt, 'meetingReminders')) {
      try {
        await sendMeetingRequestEmail({
          to: rcpt.email,
          fullName: rcpt.fullName,
          requesterName: session.user.name ?? 'Your mentee',
          topic: req.topic,
          proposedAt: req.proposedAt,
          link,
          orgId: rcpt.orgId,
          timeZone: rcpt.timezone,
          requesterTimeZone: requester?.timezone ?? null,
          // The other party, i.e. whoever is being asked to attend — not
          // `session.user.id`, who is the person asking.
          userId: recipient,
        });
      } catch (e) {
        console.error('Meeting request email failed:', e);
      }
    }
  }
  return NextResponse.json({ request: req }, { status: 201 });
}
