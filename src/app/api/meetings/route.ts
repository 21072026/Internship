import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import { sendMeetingInviteEmail } from '@/services/emailService';
import { dispatchWebhook } from '@/lib/webhooks';
import { notifyIfAllowed } from '@/lib/notify';
import { withTenantScope } from '@/lib/orgContext';
import { formatInTimeZone, isValidTimeZone, parseUserDateTime } from '@/lib/timezone';
import { generateMeetingLink } from '@/lib/meetingContext';

const schema = z.object({
  relationIds: z.array(z.string().min(1)).min(1),
  title: z.string().min(1),
  // Optional: omit/empty → a no-time meeting (just a link, no RSVP/reminder).
  scheduledAt: z.string().optional().or(z.literal('')),
  meetLink: z.string().url().optional().or(z.literal('')),
  // The clock the organizer typed the time on — the browser's zone, not their
  // saved profile zone, since the two differ exactly when someone is travelling
  // (#1210). Stored on the meeting so the invite can name the reading that was
  // actually agreed on. Invalid/absent falls back to the profile zone.
  timeZone: z.string().max(80).optional(),
});

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== 'MENTOR' && session.user.role !== 'ADMIN')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return await withTenantScope(session, async () => {
    // `relationId: { not: null }` keeps this endpoint's shape after #1051 made
    // the column nullable: every consumer (MeetingsManager, MeetingSchedulerPanel)
    // reads `m.relation.mentee.fullName`, and an admin's unfiltered query would
    // otherwise start returning project/conversation rows with a null relation.
    const where =
      session.user.role === 'ADMIN'
        ? { relationId: { not: null } }
        : { relationId: { not: null }, relation: { mentorId: session.user.id } };
    const meetings = await prisma.meeting.findMany({
      where,
      include: { relation: { include: { mentee: { select: { fullName: true } } } } },
      orderBy: { scheduledAt: 'desc' },
    });
    return NextResponse.json({ meetings });
  });
}

// POST — schedule a meeting for one or many mentees (bulk). Each gets its own
// Meeting row + RSVP token, and an emailed invite with the Meet link.
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== 'MENTOR' && session.user.role !== 'ADMIN')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return await withTenantScope(session, async () => {
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
    }
    const { relationIds, title, scheduledAt, meetLink } = parsed.data;

    // `scheduledAt` normally arrives zone-qualified from the browser. A bare wall
    // clock ("2026-08-03T16:30") still has to be honoured for API clients and for
    // browsers on a cached bundle — and must NOT go through `new Date()`, which
    // reads it in the container's zone (UTC) and so shifts the meeting by the
    // organizer's offset (#1061). Anchor it to the organizer's own zone instead.
    let when: Date | null = null;
    let organizerZone: string | null = null;
    if (scheduledAt) {
      const organizer = await prisma.user.findUnique({
        where: { id: session.user.id },
        select: { timezone: true },
      });
      when = parseUserDateTime(scheduledAt, organizer?.timezone);
      if (!when) {
        return NextResponse.json({ error: 'Validation failed', details: { scheduledAt: 'Invalid date/time' } }, { status: 400 });
      }
      const picked = parsed.data.timeZone;
      const saved = organizer?.timezone;
      organizerZone = isValidTimeZone(picked) ? picked : isValidTimeZone(saved) ? saved : null;
    }

    const where =
      session.user.role === 'ADMIN'
        ? { id: { in: relationIds } }
        : { id: { in: relationIds }, mentorId: session.user.id };
    const relations = await prisma.mentorshipRelation.findMany({
      where,
      include: { mentee: { select: { id: true, email: true, fullName: true, timezone: true } } },
    });

    // Bulk scheduling creates ONE shared meeting: everyone selected joins the
    // same room, so the video link is generated once (Jitsi, no account needed)
    // when the organizer didn't paste one. The per-person RSVP token stays
    // unique — each participant confirms attendance individually.
    const link = meetLink || generateMeetingLink({ inviteeCount: relations.length });

    let created = 0;
    const notifiedMentees = new Set<string>();
    for (const rel of relations) {
      const rsvpToken = randomBytes(24).toString('hex');
      await prisma.meeting.create({
        data: {
          relationId: rel.id,
          title,
          scheduledAt: when,
          timeZone: organizerZone,
          meetLink: link,
          rsvpToken,
          createdById: session.user.id,
        },
      });
      try {
        await sendMeetingInviteEmail({
          to: rel.mentee.email,
          fullName: rel.mentee.fullName,
          title,
          scheduledAt: when,
          meetLink: link,
          rsvpToken,
          timeZone: rel.mentee.timezone,
          // Second reading: the clock the organizer set it on, printed only when
          // it differs from the invitee's — see sendMeetingInviteEmail.
          organizerTimeZone: organizerZone,
          organizerName: session.user.name ?? null,
        });
      } catch (e) {
        console.error('Meeting invite email failed:', e);
      }
      // In-app signal alongside the invite e-mail (#924). One notification per
      // PERSON: bulk scheduling passes many relations, and a mentee with two
      // relations in the batch still joins the one shared room only once. The
      // time reads on the recipient's clock, never the server's (#1030). No
      // echo when an admin schedules a meeting on their own relation.
      if (rel.mentee.id !== session.user.id && !notifiedMentees.has(rel.mentee.id)) {
        notifiedMentees.add(rel.mentee.id);
        await notifyIfAllowed(
          rel.mentee.id,
          'meetingReminders',
          when ? 'meeting.scheduled' : 'meeting.scheduledNoTime',
          when ? { title, when: formatInTimeZone(when, rel.mentee.timezone) } : { title },
          '/portal'
        );
      }
      created++;
    }

    if (created > 0) await dispatchWebhook('meeting.scheduled', { title, scheduledAt: when ? when.toISOString() : null, count: created });
    return NextResponse.json({ created });
  });
}
