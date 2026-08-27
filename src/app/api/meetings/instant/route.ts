import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import { sendMeetingInviteEmail } from '@/services/emailService';
import { dispatchWebhook } from '@/lib/webhooks';
import { withTenantScope } from '@/lib/orgContext';
import { enforceRateLimit } from '@/lib/rateLimit';
import { emailGroupAllowedForCategory } from '@/lib/emailGroups';
import { notify } from '@/lib/notify';
import { generateMeetingLink, resolveMeetingContext, type Invitee } from '@/lib/meetingContext';

// "Start a meeting now" (#1052).
//
// The difference from POST /api/meetings is not the scheduling — it is that the
// caller gets the room back in the response. The planner endpoint answers with
// `{ created }` only, so a UI wanting to show or open the link has to re-fetch
// the list; that round trip is exactly what makes "start a call with this
// person" feel slow. Here the room is always time-less (no RSVP, no reminder)
// and the link comes straight back.
//
// POST /api/meetings is untouched — its contract has other callers.
const schema = z.object({
  title: z.string().min(1).max(200),
  relationIds: z.array(z.string().min(1)).optional(),
  projectId: z.string().min(1).optional(),
  conversationId: z.string().min(1).optional(),
});

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Each call fans out invite emails, so it is worth a cap of its own.
  const limited = enforceRateLimit(request, 'meeting-instant', { limit: 10, windowMs: 60_000 });
  if (limited) return limited;

  return await withTenantScope(session, async () => {
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
    }
    const { title, relationIds, projectId, conversationId } = parsed.data;

    const ctx = await resolveMeetingContext(session.user, { relationIds, projectId, conversationId });
    if (!ctx.ok) return NextResponse.json({ error: ctx.error }, { status: ctx.status });

    // Invitee count decides the host (1:1 → JaaS, groups → free instance);
    // resolveMeetingContext already excluded the organizer from the list.
    const meetLink = generateMeetingLink({ inviteeCount: ctx.invitees.length });

    // RELATION keeps the established shape — one row (and one RSVP token) per
    // relation, all sharing the room. PROJECT/CONVERSATION are a single row: the
    // invitee list is derived from membership, not from N relations.
    let meetingId: string;
    if (ctx.kind === 'RELATION') {
      const rows = await Promise.all(
        ctx.relationIds.map((relationId) =>
          prisma.meeting.create({
            data: {
              relationId,
              title,
              scheduledAt: null,
              meetLink,
              rsvpToken: randomBytes(24).toString('hex'),
              createdById: session.user.id,
            },
            select: { id: true, relationId: true, rsvpToken: true },
          })
        )
      );
      meetingId = rows[0].id;
      await inviteAll(ctx.invitees, rows, title, meetLink, session.user.name ?? null);
    } else {
      const row = await prisma.meeting.create({
        data: {
          projectId: ctx.projectId,
          conversationId: ctx.conversationId,
          title,
          scheduledAt: null,
          meetLink,
          rsvpToken: randomBytes(24).toString('hex'),
          createdById: session.user.id,
        },
        select: { id: true, relationId: true, rsvpToken: true },
      });
      meetingId = row.id;

      // A call started from a chat belongs in that chat (#1055): the people who
      // are already reading the thread shouldn't have to find the link in a
      // notification. Posted as the organizer, not as a faceless system row —
      // Message has no system flag, and "who called us in" is worth knowing.
      if (ctx.conversationId) {
        const who = session.user.name ?? 'Someone';
        await prisma.message.create({
          data: {
            conversationId: ctx.conversationId,
            senderId: session.user.id,
            body: `📹 ${who} started a meeting: ${title}\n${meetLink}`,
            channel: 'IN_APP',
          },
        });
      }

      await inviteAll(ctx.invitees, [row], title, meetLink, session.user.name ?? null);
    }

    await dispatchWebhook('meeting.scheduled', {
      title,
      scheduledAt: null,
      count: ctx.invitees.length,
      instant: true,
    });

    return NextResponse.json({ meetingId, meetLink, invited: ctx.invitees.length }, { status: 201 });
  });
}

type Row = { id: string; relationId: string | null; rsvpToken: string };

// Notify every invitee: always in-app, email only when they haven't opted out.
// A failure for one recipient must not sink the meeting that was already created.
async function inviteAll(
  invitees: Invitee[],
  rows: Row[],
  title: string,
  meetLink: string,
  organizer: string | null
) {
  await Promise.all(
    invitees.map(async (inv) => {
      // In-app first — it's the channel that always works.
      await notify(
        inv.userId,
        organizer ? 'meeting.started' : 'meeting.startedGeneric',
        organizer ? { organizer, title } : { title },
        meetLink
      );
      // One check, on this mail's own group. The `emailAllowed(inv,
      // 'meetingReminders')` conjunct that used to stand in front of it reads a
      // key mapping to meeting_reminders, so an opt-out from the automated
      // reminder blast killed the invitation too — invisibly, because the
      // preference surfaces showed meeting_invites as ON. That key is now in
      // meeting_invites.legacy, so the opt-out survives where it is displayed
      // and an explicit opt-in can override it.
      if (!emailGroupAllowedForCategory(inv, 'meeting-invite')) return;
      // For a relation invite, use that relation's own token; otherwise any row
      // works (a project/chat meeting has exactly one).
      const row = inv.relationId ? rows.find((r) => r.relationId === inv.relationId) : rows[0];
      if (!row) return;
      try {
        await sendMeetingInviteEmail({
          to: inv.email,
          fullName: inv.fullName,
          title,
          scheduledAt: null,
          meetLink,
          rsvpToken: row.rsvpToken,
          timeZone: inv.timezone,
          // One mail per invitee, so the id is this invitee's — the organizer is
          // not in `invitees` and must not be charged with anyone's opt-out.
          userId: inv.userId,
        });
      } catch (e) {
        console.error('Instant meeting invite email failed:', e);
      }
    })
  );
}
