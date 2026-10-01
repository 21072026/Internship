import { randomBytes } from 'crypto';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { logActivity } from '@/lib/activity';
import { sendMeetingGuestInviteEmail } from '@/services/emailService';
import { MAX_GUESTS_PER_MEETING } from '@/lib/meetingGuestLimits';
import { worldOfOrg, worldUserWhere } from '@/lib/userWorld';

// External meeting guests (#1446) — inviting someone who has no account here.
//
// Everyone else on a meeting is derived from its context (the relation's
// mentor/mentee, the project's members, the conversation's participants), so
// "who is invited" is a membership question with an answer already in the DB.
// A guest has no such anchor: the address the organizer typed IS the whole
// invitation, which is why this module owns the normalisation, the cap and the
// token minting rather than each write path repeating them.

// The cap lives in a client-safe module so the form can show it without
// importing prisma; re-exported here because every server path already reaches
// for it through this module.
export { MAX_GUESTS_PER_MEETING } from '@/lib/meetingGuestLimits';

// Deliberately narrower than RFC 5322 and identical in spirit to what the rest
// of the app accepts (z.string().email()): the address has to survive being
// handed to a mail server, and anything exotic enough to fail this is worth
// rejecting at the form rather than silently bouncing hours later.
export const guestSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  name: z.string().trim().max(120).optional().or(z.literal('')),
});

export type GuestInput = z.infer<typeof guestSchema>;

// The request-side shape, shared by every route that accepts guests so the
// cap and the message are the same everywhere.
export const guestsField = z.array(guestSchema).max(MAX_GUESTS_PER_MEETING).optional();

/**
 * Collapse a submitted guest list to what should actually be written:
 * lowercased, trimmed, de-duplicated by address (first spelling of the name
 * wins), and with any address that already belongs to a *user* removed.
 *
 * That last rule is the important one. A guest row is a second, weaker way into
 * the same meeting — no login, a bearer token in an email. If an organizer
 * types the address of someone who has an account, the right outcome is that
 * they are reached the normal way (as a participant of the meeting's context),
 * not that a token gets minted against their address; otherwise anyone able to
 * schedule a meeting could mint a credential addressed at a colleague. The
 * caller decides what to do with `rejectedAsMembers` — the UI says why.
 *
 * "Has an account" is asked IN THE MEETING'S WORLD (#2590). One person can hold
 * an internship account and a marketing account under the same address; those
 * are two different people as far as this meeting is concerned. Someone who is
 * only a member of the OTHER product cannot reach this meeting as a participant
 * — they are not in its tenant, and the product they sign into on the host they
 * use would not show it — so treating their other-world account as "already
 * reachable" would silently drop the very invitation the organizer asked for.
 * The guest link (a bearer token in a mail) is exactly how an outsider gets in.
 */
export async function normalizeGuests(
  guests: GuestInput[] | undefined,
  /** Addresses already invited through the meeting's context, lowercased. */
  memberEmails: string[],
  /**
   * The organization the meeting belongs to — the organizer's own. Its world is
   * what "has an account here" means; required (not defaulted) so a new caller
   * has to say which world it is asking about.
   */
  orgId: string | null | undefined
): Promise<{ guests: { email: string; name: string | null }[]; rejectedAsMembers: string[] }> {
  if (!guests || guests.length === 0) return { guests: [], rejectedAsMembers: [] };

  const seen = new Map<string, string | null>();
  for (const g of guests) {
    const email = g.email.trim().toLowerCase();
    if (!email) continue;
    if (!seen.has(email)) seen.set(email, g.name ? g.name.trim() : null);
  }

  const rejected = new Set<string>();

  // Already on this meeting through its context — no second, weaker invitation.
  const members = new Set(memberEmails.map((e) => e.toLowerCase()));
  for (const e of [...seen.keys()]) {
    if (members.has(e)) {
      rejected.add(e);
      seen.delete(e);
    }
  }

  // Has an account here — reached as a participant, not as a guest.
  //
  // "Here" means this tenant: `User` is a TENANT_MODEL (src/lib/orgContext.ts),
  // so under MT_ENFORCE_ISOLATION this query does not see another org's users
  // and they are treated as outsiders. That is the intended reading — someone in
  // a different tenant genuinely cannot reach this meeting through the app, so a
  // guest invitation is the only way to invite them, and it is the one the
  // organizer asked for.
  //
  // The tenant filter is dormant while that flag is off (it is, in production),
  // so the WORLD is also named in the query itself (#2590): without it, a
  // person's account in the other product — same address, different tenant —
  // would be found and the guest wrongly refused as a "member". Scoping by world
  // rather than by exact org keeps the pre-worlds behaviour for a single-product
  // deployment byte-for-byte (every account is in the one world).
  if (seen.size > 0) {
    const world = await worldOfOrg(orgId);
    const users = await prisma.user.findMany({
      where: { email: { in: [...seen.keys()] }, ...worldUserWhere(world) },
      select: { email: true },
    });
    for (const u of users) {
      const e = u.email.toLowerCase();
      rejected.add(e);
      seen.delete(e);
    }
  }

  return {
    guests: [...seen.entries()].map(([email, name]) => ({ email, name })),
    rejectedAsMembers: [...rejected],
  };
}

/**
 * Write the guest rows for one meeting and mail each of them an RSVP invite.
 *
 * Guests attach to a SINGLE meeting row on purpose. A bulk schedule fans out
 * one Meeting row per relation, all sharing one video room; mailing the same
 * outsider once per relation would be a bug, so callers pass the first row of
 * the batch and every guest is invited exactly once, to the shared room.
 *
 * Returns the rows actually created. An address already on this meeting is
 * skipped rather than erroring — re-submitting the form must not 500, and the
 * @@unique([meetingId, email]) index is what makes that safe under a race.
 */
export async function inviteGuests({
  meetingId,
  guests,
  invitedById,
  title,
  scheduledAt,
  meetLink,
  organizerTimeZone,
  organizerName,
  durationMinutes,
}: {
  meetingId: string;
  guests: { email: string; name: string | null }[];
  invitedById: string;
  title: string;
  scheduledAt: Date | null;
  meetLink: string | null;
  organizerTimeZone: string | null;
  organizerName: string | null;
  // The meeting's stored length, for the guest's .ics (#1984). Optional so a
  // caller that has none gets the one default, never the old 30.
  durationMinutes?: number | null;
}): Promise<{ id: string; email: string; name: string | null; rsvp: string }[]> {
  const created: { id: string; email: string; name: string | null; rsvp: string }[] = [];

  // LOCALE (#1720): a MeetingGuest is an address, not an account — there is no
  // `preferredLanguage` to read and no browser of theirs in play. The organizer
  // is the only person who knows anything about this recipient (they typed the
  // address in), so their language is what the guest mail is written in — the
  // same reasoning `organizerTimeZone` already follows. Read here rather than at
  // the two call sites so both can never drift apart.
  const organizer = await prisma.user.findUnique({
    where: { id: invitedById },
    // orgId: a guest has no world of their own, so the invite (RSVP links
    // included) belongs to the organizer's product (docs/worlds.md).
    select: { preferredLanguage: true, orgId: true },
  });
  const locale = organizer?.preferredLanguage ?? null;

  for (const g of guests) {
    let row;
    try {
      row = await prisma.meetingGuest.create({
        data: {
          meetingId,
          email: g.email,
          name: g.name,
          rsvpToken: randomBytes(24).toString('hex'),
          invitedById,
        },
        select: { id: true, email: true, name: true, rsvp: true, rsvpToken: true },
      });
    } catch {
      // Already invited to this meeting (unique violation) — not an error.
      continue;
    }
    created.push({ id: row.id, email: row.email, name: row.name, rsvp: row.rsvp });

    // Fire per guest, never in a Promise.all over an unbounded list, and never
    // fatal: a bad address must not undo a meeting that is already scheduled.
    try {
      await sendMeetingGuestInviteEmail({
        to: row.email,
        name: row.name,
        title,
        scheduledAt,
        meetLink,
        rsvpToken: row.rsvpToken,
        organizerTimeZone,
        organizerName,
        locale,
        orgId: organizer?.orgId ?? null,
        // Same UID as the account-holders' invite for this meeting, so a guest
        // who also has a calendar entry from elsewhere sees one event, not two.
        icsUid: meetingId,
        durationMinutes,
      });
    } catch (e) {
      logger.error('Meeting guest invite email failed', { meetingId, error: String(e) });
    }
  }

  // One line per fan-out, not per guest: what an admin reviewing the log wants
  // to see is "this account mailed N outsiders", and EmailLog already holds the
  // per-address detail.
  if (created.length > 0) {
    await logActivity({
      action: 'meeting.guest.invited',
      actorId: invitedById,
      targetType: 'Meeting',
      targetId: meetingId,
      detail: `${created.length} guest(s): ${created.map((g) => g.email).join(', ')}`,
    });
  }

  return created;
}
