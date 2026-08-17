import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { canManageProject, isProjectMember } from '@/lib/projectAccess';
import { sendMeetingInviteEmail } from '@/services/emailService';
import { dispatchWebhook } from '@/lib/webhooks';
import { withTenantScope } from '@/lib/orgContext';
import { nextOccurrence } from '@/lib/meetingSeriesOccurrences';
import { isValidTimeZone } from '@/lib/timezone';
import { generateMeetingLink } from '@/lib/meetingRoom';

// A recurring project meeting is a *rule*, not a pile of rows (#1110).
//
// Until now creating a series materialised one `Meeting` row per mentee per
// occurrence, weeks ahead. That made the feature impossible to manage:
//   - cancelling the series only flipped `active` to false, so every generated
//     row stayed on everyone's calendar forever;
//   - moving it to another day/time left the old slots behind next to the new
//     ones;
//   - the calendar rendered one entry per mentee, so a six-person team turned
//     one weekly call into six look-alike entries carrying people's names
//     instead of the meeting's own title.
//
// So nothing is stored per occurrence any more. The rule is the single source
// of truth; the calendar, the dashboard banner and the reminder cron all expand
// it on the fly. Editing it moves the meeting, deleting it removes it — with no
// residue. `purgeGeneratedMeetings` cleans up rows left by the old behaviour.

const timePattern = /^([01]\d|2[0-3]):([0-5]\d)$/;

const recurrenceSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().min(1),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1),
  timeOfDay: z.string().regex(timePattern),
  // The clock `timeOfDay` is on. The browser sends its own IANA zone; an API
  // client may omit it, in which case the deployment default applies.
  timeZone: z.string().min(1).max(64).optional(),
  meetLink: z.string().url().optional().or(z.literal('')),
  // Accepted for backwards compatibility with older clients; occurrences are no
  // longer generated ahead of time, so it no longer influences anything.
  weeksAhead: z.number().int().min(1).max(26).optional(),
  active: z.boolean().optional(),
});

const updateSchema = recurrenceSchema.partial().extend({ id: z.string().min(1) });

const deleteSchema = z.object({ id: z.string().min(1) });

async function ensureProjectAccess(
  user: { id: string; role: string; companyId?: string | null },
  projectId: string
) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, ownerType: true, ownerUserId: true, ownerCompanyId: true },
  });
  if (!project) return { error: NextResponse.json({ error: 'Not found' }, { status: 404 }) as NextResponse };
  if (user.role !== 'ADMIN') {
    const member = await isProjectMember(user, projectId);
    if (!canManageProject(user, project) && !member) {
      return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) as NextResponse };
    }
  }
  return { project };
}

/**
 * Drop every `Meeting` row this series ever generated. Nothing writes them any
 * more, but deployments carry years of them; leaving one behind is exactly the
 * ghost entry this rewrite is about. Notes taken in a meeting survive — the
 * `PersonalNote.meetingId` FK is `SetNull`.
 */
async function purgeGeneratedMeetings(seriesId: string) {
  const { count } = await prisma.meeting.deleteMany({ where: { seriesId } });
  return count;
}

/** Days/time/zone/link that decide *when and where* — a change to any of them moves the meeting. */
function scheduleFingerprint(s: { daysOfWeek: unknown; timeOfDay: string; timeZone: string | null; fixedLink: string | null }) {
  const days = Array.isArray(s.daysOfWeek) ? [...(s.daysOfWeek as unknown[])].map(Number).sort((a, b) => a - b) : [];
  return `${days.join(',')}|${s.timeOfDay}|${s.timeZone ?? ''}|${s.fixedLink ?? ''}`;
}

/**
 * Announce the next occurrence to the project's mentees. Only the *next* one is
 * mailed: the rule runs indefinitely, and everything after it is covered by the
 * reminders the cron sends a day before and an hour before
 * (`sendProjectMeetingSeriesReminders`). No RSVP — there is no row to RSVP to.
 */
async function announceNextOccurrence(
  series: { id: string; projectId: string | null; title: string; daysOfWeek: unknown; timeOfDay: string; timeZone: string | null; fixedLink: string | null; active: boolean },
  role: string,
  sessionUserId: string
) {
  if (!series.active || !series.projectId) return { invited: 0, nextOccurrence: null as string | null };

  const next = nextOccurrence(series.daysOfWeek, series.timeOfDay, series.timeZone);
  if (!next) return { invited: 0, nextOccurrence: null };

  const memberMentees = await prisma.projectMember.findMany({
    where: { projectId: series.projectId, role: 'MENTEE' },
    select: { userId: true },
  });
  const menteeIds = [...new Set(memberMentees.map((m) => m.userId))];

  const relations = await prisma.mentorshipRelation.findMany({
    where: {
      projectId: series.projectId,
      status: 'ACTIVE',
      ...(role === 'MENTOR' ? { mentorId: sessionUserId } : {}),
      ...(menteeIds.length > 0 ? { menteeId: { in: menteeIds } } : {}),
    },
    include: { mentee: { select: { email: true, fullName: true, timezone: true } } },
  });

  let invited = 0;
  const mailed = new Set<string>();
  for (const rel of relations) {
    if (mailed.has(rel.mentee.email)) continue;
    mailed.add(rel.mentee.email);
    try {
      await sendMeetingInviteEmail({
        to: rel.mentee.email,
        fullName: rel.mentee.fullName,
        title: series.title,
        scheduledAt: next,
        meetLink: series.fixedLink,
        timeZone: rel.mentee.timezone,
        // The rule's own clock — "09:00 on Mondays" is 09:00 *somewhere*, and an
        // invitee in another zone should see which somewhere (#1210).
        organizerTimeZone: series.timeZone,
      });
      invited++;
    } catch (e) {
      console.error('Meeting series invite email failed:', e);
    }
  }

  if (invited > 0) {
    await dispatchWebhook('meeting.scheduled', {
      title: series.title,
      scheduledAt: next.toISOString(),
      count: invited,
      seriesId: series.id,
    });
  }

  return { invited, nextOccurrence: next.toISOString() };
}

// GET ?projectId= — the project's recurring meetings. Readable by anyone who can
// see the project's internals, mentee members included (#51): "the weekly call is
// Mon+Thu 09:30, here is the link" is exactly what a member needs, and it was
// stored but never surfaced anywhere in the UI.
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  return await withTenantScope(session, async () => {
    const projectId = new URL(request.url).searchParams.get('projectId') || '';
    if (!projectId) return NextResponse.json({ error: 'projectId is required' }, { status: 400 });

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, ownerType: true, ownerUserId: true, ownerCompanyId: true },
    });
    if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (
      session.user.role !== 'ADMIN' &&
      !canManageProject(session.user, project) &&
      !(await isProjectMember(session.user, projectId))
    ) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const series = await prisma.meetingSeries.findMany({
      where: { projectId, active: true },
      orderBy: { createdAt: 'asc' },
      select: { id: true, title: true, daysOfWeek: true, timeOfDay: true, timeZone: true, fixedLink: true, active: true },
    });
    return NextResponse.json({
      series: series.map((s) => ({
        ...s,
        // The rule alone reads as a puzzle ("Mon, Thu · 09:00" — is that today?);
        // the resolved next occurrence is what people actually want to know, and
        // it is the only form that survives the reader being in another zone.
        nextOccurrence: nextOccurrence(s.daysOfWeek, s.timeOfDay, s.timeZone)?.toISOString() ?? null,
      })),
    });
  });
}

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== 'MENTOR' && session.user.role !== 'ADMIN')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return await withTenantScope(session, async () => {
    const parsed = recurrenceSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
    }
    const { projectId, title, daysOfWeek, timeOfDay, timeZone, meetLink, active } = parsed.data;
    const access = await ensureProjectAccess(session.user, projectId);
    if (access.error) return access.error;

    const fixedLink = meetLink || generateMeetingLink();
    const series = await prisma.meetingSeries.create({
      data: {
        projectId,
        title,
        daysOfWeek,
        timeOfDay,
        timeZone: isValidTimeZone(timeZone) ? timeZone : null,
        fixedLink,
        active: active ?? true,
        createdById: session.user.id,
      },
    });

    const announced = await announceNextOccurrence(series, session.user.role, session.user.id);
    return NextResponse.json(
      { series: { ...series, nextOccurrence: announced.nextOccurrence }, invitesSent: announced.invited },
      { status: 201 }
    );
  });
}

export async function PUT(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== 'MENTOR' && session.user.role !== 'ADMIN')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return await withTenantScope(session, async () => {
    const parsed = updateSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
    }
    const { id, weeksAhead: _weeksAhead, ...incoming } = parsed.data;

    const current = await prisma.meetingSeries.findUnique({ where: { id } });
    if (!current) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const targetProjectId = incoming.projectId ?? current.projectId;
    if (!targetProjectId) return NextResponse.json({ error: 'projectId is required' }, { status: 400 });
    const access = await ensureProjectAccess(session.user, targetProjectId);
    if (access.error) return access.error;

    const data: {
      projectId?: string;
      title?: string;
      daysOfWeek?: number[];
      timeOfDay?: string;
      timeZone?: string | null;
      fixedLink?: string | null;
      active?: boolean;
    } = {};
    if (incoming.projectId !== undefined) data.projectId = incoming.projectId;
    if (incoming.title !== undefined) data.title = incoming.title;
    if (incoming.daysOfWeek !== undefined) data.daysOfWeek = incoming.daysOfWeek;
    if (incoming.timeOfDay !== undefined) data.timeOfDay = incoming.timeOfDay;
    if (incoming.timeZone !== undefined) data.timeZone = isValidTimeZone(incoming.timeZone) ? incoming.timeZone : null;
    if (incoming.meetLink !== undefined) data.fixedLink = incoming.meetLink || null;
    if (incoming.active !== undefined) data.active = incoming.active;

    const updated = await prisma.meetingSeries.update({ where: { id }, data });

    // Moved to another day/time/room: nothing may survive at the old slot. That
    // includes rows generated before this endpoint stopped writing them, and the
    // "we already told you about this occurrence" reminder ledger — the new time
    // deserves a fresh announcement.
    const moved = scheduleFingerprint(current) !== scheduleFingerprint(updated);
    if (moved || updated.active === false) {
      await purgeGeneratedMeetings(id);
    }
    if (moved) {
      await prisma.meetingSeriesReminder.deleteMany({ where: { seriesId: id, occurrenceAt: { gte: new Date() } } });
    }

    // Only re-announce when the meeting actually moved. Renaming it, or saving
    // the same form twice, must not mail the whole team again.
    const announced = moved
      ? await announceNextOccurrence(updated, session.user.role, session.user.id)
      : {
          invited: 0,
          nextOccurrence: updated.active
            ? nextOccurrence(updated.daysOfWeek, updated.timeOfDay, updated.timeZone)?.toISOString() ?? null
            : null,
        };

    return NextResponse.json({ series: { ...updated, nextOccurrence: announced.nextOccurrence }, invitesSent: announced.invited });
  });
}

// DELETE — cancel the recurring meeting. It disappears everywhere, immediately:
// the rule is deactivated *and* every occurrence it ever put in the database is
// removed, so no ghost entry is left on anyone's calendar (#1110).
export async function DELETE(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== 'MENTOR' && session.user.role !== 'ADMIN')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return await withTenantScope(session, async () => {
    const parsed = deleteSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

    const current = await prisma.meetingSeries.findUnique({ where: { id: parsed.data.id } });
    if (!current) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    if (current.projectId) {
      const access = await ensureProjectAccess(session.user, current.projectId);
      if (access.error) return access.error;
    }

    const removedMeetings = await purgeGeneratedMeetings(parsed.data.id);
    const series = await prisma.meetingSeries.update({
      where: { id: parsed.data.id },
      data: { active: false },
    });
    return NextResponse.json({ ok: true, series, removedMeetings });
  });
}
