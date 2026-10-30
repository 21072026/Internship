import { NextResponse } from 'next/server';
import { requireRoleOrPermission } from '@/lib/authz';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import { sendMeetingInviteEmail } from '@/services/emailService';
import { emit } from '@/lib/events/emit';
import { notifyEvent } from '@/lib/notifications/router';
import { meetingChatCard } from '@/lib/meetingChatCard';
import { withTenantScope } from '@/lib/orgContext';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import type { Prisma } from '@prisma/client';
import { enforceRateLimit } from '@/lib/rateLimit';
import { formatInTimeZone, isValidTimeZone, parseUserDateTime } from '@/lib/timezone';
import { resolveMeetingLink } from '@/lib/meetingContext';
import { meetingLinkRefusal } from '@/lib/meetingRoom';
import { recordPairActivity } from '@/lib/metering';
import { pushMeetingInBackground } from '@/lib/googleCalendarSync';
import { guestsField, inviteGuests, normalizeGuests } from '@/lib/meetingGuests';
import { durationMinutesField, meetingEnd } from '@/lib/meetingDuration';
import { bookWithoutConflict, conflictBody, recordForcedBooking } from '@/lib/busyWindows';
import { findPolicyViolation, policyBody, policyExempt, recordPolicyOverride } from '@/lib/bookingPolicy';
import type { PolicyViolation } from '@/lib/bookingPolicyRule';

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
  // How long it runs (#1984). Omitted → the one default, stored as null so the
  // row keeps following the default if it ever changes.
  durationMinutes: durationMinutesField,
  // Outsiders with no account here (#1446). Each gets its own RSVP token and
  // the same emailed yes/no buttons; see src/lib/meetingGuests.ts for why the
  // whole batch is attached to ONE of the created rows.
  guests: guestsField,
  // Book over a collision on purpose (#1995). Only an admin or the mentor can
  // reach this route, so whoever may send it may use it; it is recorded.
  force: z.boolean().optional(),
});

export async function GET(request: Request) {
  // Every role's scope is spelled out (#913) — an unlisted role (COMPANY,
  // SOURCE) is rejected, never silently given everything (the #831
  // allowlist-by-omission lesson). An admin is judged by the permission layer (#1571).
  const gate = await requireRoleOrPermission(['MENTOR', 'MENTEE'], 'program.read', { request });
  if ('error' in gate) return gate.error;
  const { session, admin } = gate;
  const role = session.user.role;
  return await withTenantScope(session, async () => {
    // `relationId: { not: null }` keeps this endpoint's shape after #1051 made
    // the column nullable: every consumer (MeetingsManager, MeetingSchedulerPanel)
    // reads `m.relation.mentee.fullName`, and an admin's unfiltered query would
    // otherwise start returning project/conversation rows with a null relation.
    //
    // The relation is also where the tenant lives (Meeting has no orgId): an
    // ADMIN's list used to be every tenant's meetings, since the middleware
    // scopes nothing with MT_ENFORCE_ISOLATION off (#2542 follow-up). Every
    // role's relation filter is narrowed to the caller's tenant.
    const relationWhere: Prisma.MentorshipRelationWhereInput = withinTenant<Prisma.MentorshipRelationWhereInput>(
      admin ? {} : role === 'MENTOR' ? { mentorId: session.user.id } : { menteeId: session.user.id },
      await tenantWhere(session),
    );
    const where: Prisma.MeetingWhereInput = { relationId: { not: null }, relation: { is: relationWhere } };
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
        ...(admin || role === 'MENTOR'
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
  const gate = await requireRoleOrPermission(['MENTOR'], 'relation.write', { request });
  if ('error' in gate) return gate.error;
  const { session, admin } = gate;

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
    const { relationIds, title, scheduledAt, meetLink, guests, durationMinutes, force } = parsed.data;

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

    // Relation ids come from the client: an admin may schedule on any relation
    // OF THEIR TENANT, a mentor on their own. A foreign id is dropped exactly
    // like a missing one (#2542 follow-up).
    const where = withinTenant(
      admin
        ? { id: { in: relationIds } }
        : { id: { in: relationIds }, mentorId: session.user.id },
      await tenantWhere(session),
    );
    const relations = await prisma.mentorshipRelation.findMany({
      where,
      // `preferredLanguage` for #1720, next to `timezone` for the same reason:
      // the invite is rendered once per invitee, in their own settings.
      include: { mentee: { select: { id: true, email: true, fullName: true, timezone: true, preferredLanguage: true } } },
    });

    // Bulk scheduling creates ONE shared meeting: everyone selected joins the
    // same room, so the video link is resolved once — pasted, the organizer's
    // saved room, or a room of ours, as the tenant's policy says (#2007). The
    // per-person RSVP token stays unique — each participant confirms
    // attendance individually.
    const resolved = await resolveMeetingLink({
      pastedLink: meetLink,
      inviteeCount: relations.length,
      orgId: session.user.orgId,
      organizerId: session.user.id,
    });
    if (!resolved.ok) return meetingLinkRefusal(resolved);
    const link = resolved.link;

    // Guests are resolved once for the whole batch: they are invited to the
    // shared room, not to each relation. Anyone with an account is dropped here
    // and reached the normal way instead — see normalizeGuests.
    const { guests: guestList, rejectedAsMembers } = await normalizeGuests(guests, [
      ...relations.map((r) => r.mentee.email),
      // The organizer's own address too. It would be caught anyway by the
      // has-an-account lookup, but passing it explicitly makes the *reason*
      // reported back to the UI the right one.
      ...(session.user.email ? [session.user.email] : []),
    ],
    // The organizer's org: "has an account" is asked in ITS world (#2590), so
    // the same address held in the other product does not veto a guest invite.
    session.user.orgId);

    // The shared identity of this one schedule (#1980). Every row written below
    // carries it, so a later "cancel this meeting" can ask whether it means this
    // invitee or the whole session — a bulk schedule fans out into one row per
    // invitee sharing a single room, and there was no way to name that group.
    const batchKey = randomBytes(12).toString('hex');

    let created = 0;
    // The row the guests hang off — the first one written in this batch.
    let guestHostMeetingId: string | null = null;
    const notifiedMentees = new Set<string>();
    // Per invitee, not all-or-nothing (#1995): a bulk schedule writes the rows
    // that are free and reports the ones that collide.
    // A mentor's booking rules (#2003) refuse per invitee the same way.
    const conflicts: { relationId: string; menteeName: string; conflictsWith?: { title: string; startsAt: string }; policy?: PolicyViolation }[] = [];
    for (const rel of relations) {
      const rsvpToken = randomBytes(24).toString('hex');
      const data = {
        relationId: rel.id,
        title,
        scheduledAt: when,
        durationMinutes: durationMinutes ?? null,
        timeZone: organizerZone,
        meetLink: link,
        rsvpToken,
        createdById: session.user.id,
        batchKey,
      };
      let meeting: Awaited<ReturnType<typeof prisma.meeting.create>>;
      if (when) {
        // Lock the pair, check, write — one transaction, so two bookings of
        // the same hour cannot both land.
        const end = meetingEnd(when, { durationMinutes });
        const booked = await bookWithoutConflict(
          {
            viewer: session.user,
            userIds: [rel.mentorId, rel.menteeId],
            window: { start: when, end },
            force,
            excludeBatchKey: batchKey,
            // The mentor's own bookings are exempt from their rules; an admin
            // is bound by them unless they force it (recorded below).
            extraCheck: policyExempt(session.user, rel.mentorId) ? undefined : (tx, external) => findPolicyViolation(tx, { mentorId: rel.mentorId, start: when, end, excludeBatchKey: batchKey, external }),
          },
          (tx) => tx.meeting.create({ data }),
        );
        if (!booked.ok) {
          conflicts.push(
            booked.conflict
              ? { relationId: rel.id, menteeName: rel.mentee.fullName, conflictsWith: conflictBody(booked.conflict).conflictsWith }
              : { relationId: rel.id, menteeName: rel.mentee.fullName, policy: booked.refused },
          );
          continue;
        }
        meeting = booked.result;
        if (booked.forcedOver) await recordForcedBooking(session.user.id, meeting.id, booked.forcedOver);
        if (booked.forcedRule) await recordPolicyOverride(session.user.id, meeting.id, booked.forcedRule);
      } else {
        meeting = await prisma.meeting.create({ data });
      }
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
          // The links open this tenant's product host (#2495).
          orgId: session.user.orgId,
          // The Meeting row's own id, so the attachment, the public token route
          // and any later reschedule mail all address the same calendar event.
          icsUid: meeting.id,
          durationMinutes: meeting.durationMinutes,
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
        // Through the router (#1942): the bell, and a chat card with the join
        // button for a mentee who linked chat. The mail went out above.
        const chatCard = meetingChatCard(meeting, 'invite');
        const dedupeKey = `meeting-invite:${meeting.id}`;
        if (when) {
          await notifyEvent(rel.mentee.id, 'meeting.scheduled', { title, when: formatInTimeZone(when, rel.mentee.timezone) }, { dedupeKey, chatCard });
        } else {
          await notifyEvent(rel.mentee.id, 'meeting.scheduledNoTime', { title }, { dedupeKey, chatCard });
        }
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
        durationMinutes: durationMinutes ?? null,
      });
    }

    // Metering signal (#1750) — volume, not the pair count. One increment per
    // Meeting row written, because a bulk schedule is activity on each of those
    // relations. See the note in /api/interactions.
    if (created > 0) recordPairActivity(session.user.orgId, created);

    if (created > 0) await emit('meeting.scheduled', { title, scheduledAt: when ? when.toISOString() : null, count: created }, { orgId: session.user.orgId ?? null, actor: { id: session.user.id, type: 'user' } });
    // Nothing could be booked: the whole request collided (#1995).
    if (created === 0 && conflicts.length > 0) {
      const first = conflicts[0];
      return NextResponse.json(
        first.policy
          ? { ...policyBody(first.policy), conflicts }
          : { error: 'This time collides with another meeting', code: 'conflict', conflictsWith: first.conflictsWith, conflicts },
        { status: 409 },
      );
    }
    return NextResponse.json({ created, guestsInvited: invitedGuests.length, guests: invitedGuests, rejectedAsMembers, conflicts });
  });
}
