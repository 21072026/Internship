import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import { sendMeetingInviteEmail } from '@/services/emailService';
import { dispatchWebhook } from '@/lib/webhooks';
import { withTenantScope } from '@/lib/orgContext';

const schema = z.object({
  relationIds: z.array(z.string().min(1)).min(1),
  title: z.string().min(1),
  // Optional: omit/empty → a no-time meeting (just a link, no RSVP/reminder).
  scheduledAt: z.string().optional().or(z.literal('')),
  meetLink: z.string().url().optional().or(z.literal('')),
});

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== 'MENTOR' && session.user.role !== 'ADMIN')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return await withTenantScope(session, async () => {
    const where =
      session.user.role === 'ADMIN' ? {} : { relation: { mentorId: session.user.id } };
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
    const when = scheduledAt ? new Date(scheduledAt) : null;

    const where =
      session.user.role === 'ADMIN'
        ? { id: { in: relationIds } }
        : { id: { in: relationIds }, mentorId: session.user.id };
    const relations = await prisma.mentorshipRelation.findMany({
      where,
      include: { mentee: { select: { email: true, fullName: true } } },
    });

    let created = 0;
    for (const rel of relations) {
      const rsvpToken = randomBytes(24).toString('hex');
      // Auto-generate a ready-to-use video link (Jitsi, no account needed) when
      // the organizer didn't paste one — each meeting gets its own room.
      const link = meetLink || `https://meet.jit.si/InternshipCRM-${randomBytes(8).toString('hex')}`;
      await prisma.meeting.create({
        data: {
          relationId: rel.id,
          title,
          scheduledAt: when,
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
        });
      } catch (e) {
        console.error('Meeting invite email failed:', e);
      }
      created++;
    }

    if (created > 0) await dispatchWebhook('meeting.scheduled', { title, scheduledAt: when ? when.toISOString() : null, count: created });
    return NextResponse.json({ created });
  });
}
