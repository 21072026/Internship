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
import { enforceRateLimit } from '@/lib/rateLimit';
import { formatInTimeZone, isValidTimeZone, parseUserDateTime } from '@/lib/timezone';
import { generateMeetingLink } from '@/lib/meetingContext';
import { pushMeetingInBackground } from '@/lib/googleCalendarSync';
import { guestsField, inviteGuests, normalizeGuests } from '@/lib/meetingGuests';

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
  // Outsiders with no account here (#1446). Each gets its own RSVP token and
  // the same emailed yes/no buttons; see src/lib/meetingGuests.ts for why the
  // whole batch is attached to ONE of the created rows.
  guests: guestsField,
});

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  // Every role's scope is spelled out (#913) — an unlisted role (COMPANY,
  // SOURCE) is rejected, never silently given everything (the #831
  // allowlist-by-omission lesson).
  const role = session.user.role;
  if (role !== 'ADMIN' && role !== 'MENTOR' && role !== 'MENTEE') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return await withTenantScope(session, async () => {
    // `relationId: { not: null }` keeps this endpoint's shape after #1051 made
    // the column nullable: every consumer (MeetingsManager, MeetingSchedulerPanel)
    // reads `m.relation.mentee.fullName`, and an admin's unfiltered query would
    // otherwise start returning project/conversation rows with a null relation.
    const where =
      role === 'ADMIN'
        ? { relationId: { not: null } }
        : role === 'MENTOR'
          ? { relationId: { not: null }, relation: { mentorId: session.user.id } }
          : { relationId: { not: null }, relation: { menteeId: session.user.id } };
    // An explicit allowlist, never `include` (#1548). A bare `include` serialises
    // every column of the row, and one of them — `rsvpToken` — is a bearer
    // credential: /rsvp/<token> is on the middleware's public allowlist and
    // /api/calendar/<token> serves the event, so whoever holds it can answer the
    // invitation AS the mentee with no session at all. Listing the fields keeps a
    // future column out of the payload by default instead of by accident.
    const meetings = await prisma.meeting.findMany({
      where,
      select: {
        id: true,
        relationId: true,
        title: true,
        scheduledAt: true,
        timeZone: true,
        meetLink: true,
        rsvp: true,
        endedAt: true,
        // Called off (#1980), with the reason the organiser gave. Every reader
        // of this list has to be able to tell a meeting that is on from one
        // that is not — the portal drops the cancelled ones, the mentor and
        // admin surfaces mark them.
        status: true,
        cancelReason: true,
        createdAt: true,
        // The token belongs to the mentee the meeting was written for — it is
        // the same credential their invite e-mail carries, and the portal's
        // in-app RSVP + "add to calendar" (UpcomingMeetings) run on it. A mentor
        // or an admin has a session and never needs it, so they never get it.
        ...(role === 'MENTEE' ? { rsvpToken: true } : {}),
        relation: { select: { mentee: { select: { id: true, fullName: true } } } },
        // The organizer has to be able to see whether the outsiders they invited
        // said yes — otherwise the invite is send-and-forget (#1446). A MENTEE is
        // not the organizer of their own meeting: the addresses were typed by
        // their mentor, they are a third party's PII, and this same payload is
        // rendered on /portal. So the list is included only for the roles that
        // can actually invite.
        ...(role === 'ADMIN' || role === 'MENTOR'
          ? {
              guests: {
                select: { id: true, email: true, name: true, rsvp: true },
                orderBy: { createdAt: 'asc' as const },
              },
            }
          : {}),
      },
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

  // Unlimited until #1446. Scheduling always mailed people, but only people the
  // caller was already connected to; it can now mail addresses the caller typed,
  // which is worth a cap of its own. Well above any real scheduling session.
  const limited = enforceRateLimit(request, 'meeting-schedule', { limit: 20, windowMs: 60_000 });
  if (limited) return limited;

  return await withTenantScope(session, async () => {
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
    }
    const { relationIds, title, scheduledAt, meetLink, guests } = parsed.data;

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
      // `preferredLanguage` for #1720, next to `timezone` for the same reason:
      // the invite is rendered once per invitee, in their own settings.
      include: { mentee: { select: { id: true, email: true, fullName: true, timezone: true, preferredLanguage: true } } },
    });

    // Bulk scheduling creates ONE shared meeting: everyone selected joins the
    // same room, so the video link is generated once (Jitsi, no account needed)
    // when the organizer didn't paste one. The per-person RSVP token stays
    // unique — each participant confirms attendance individually.
    const link = meetLink || generateMeetingLink({ inviteeCount: relations.length });

    // Guests are resolved once for the whole batch: they are invited to the
    // shared room, not to each relation. Anyone with an account is dropped here
    // and reached the normal way instead — see normalizeGuests.
    const { guests: guestList, rejectedAsMembers } = await normalizeGuests(guests, [
      ...relations.map((r) => r.mentee.email),
      // The organizer's own address too. It would be caught anyway by the
      // has-an-account lookup, but passing it explicitly makes the *reason*
      // reported back to the UI the right one.
      ...(session.user.email ? [session.user.email] : []),
    ]);

    // The shared identity of this one schedule (#1980). Every row written below
    // carries it, so a later "cancel this meeting" can ask whether it means this
    // invitee or the whole session — a bulk schedule fans out into one row per
    // invitee sharing a single room, and there was no way to name that group.
    const batchKey = randomBytes(12).toString('hex');

    let created = 0;
    // The row the guests hang off — the first one written in this batch.
    let guestHostMeetingId: string | null = null;
    const notifiedMentees = new Set<string>();
    for (const rel of relations) {
      const rsvpToken = randomBytes(24).toString('hex');
      const meeting = await prisma.meeting.create({
        data: {
          relationId: rel.id,
          title,
          scheduledAt: when,
          timeZone: organizerZone,
          meetLink: link,
          rsvpToken,
          createdById: session.user.id,
          batchKey,
        },
      });
      guestHostMeetingId ??= meeting.id;
      // Mirror into the calendars of whoever connected their own Google account
      // (#709). A no-op unless the operator enabled the integration and the
      // person opted in; unconnected users keep the e-mail + .ics path exactly
      // as before. Fire-and-forget — a third party's API must never be able to
      // make scheduling a meeting fail or hang.
      pushMeetingInBackground(meeting, [session.user.id, rel.mentee.id]);
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
          // The invitee — never `session.user.id`, which is the organizer who is
          // not a recipient of this mail. There is no call-site preference check
          // on this path and never was; supplying the id is what puts it under
          // sendEmail's central enforcement (group meeting_invites), which is
          // the entire point of the change.
          userId: rel.mentee.id,
          // #1720: the invitee's stored language — they have an account, so
          // nothing has to be guessed.
          locale: rel.mentee.preferredLanguage,
          // The Meeting row's own id, so the attachment, the public token route
          // and any later reschedule mail all address the same calendar event.
          icsUid: meeting.id,
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

    // Guests are invited only once the meeting actually exists: a mail with a
    // token that resolves to nothing is worse than no mail at all.
    let invitedGuests: { id: string; email: string; name: string | null; rsvp: string }[] = [];
    if (guestHostMeetingId && guestList.length > 0) {
      invitedGuests = await inviteGuests({
        meetingId: guestHostMeetingId,
        guests: guestList,
        invitedById: session.user.id,
        title,
        scheduledAt: when,
        meetLink: link,
        organizerTimeZone: organizerZone,
        organizerName: session.user.name ?? null,
      });
    }

    if (created > 0) await dispatchWebhook('meeting.scheduled', { title, scheduledAt: when ? when.toISOString() : null, count: created });
    return NextResponse.json({ created, guestsInvited: invitedGuests.length, guests: invitedGuests, rejectedAsMembers });
  });
}
