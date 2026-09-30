import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { canManageProject, isProjectMember } from '@/lib/projectAccess';
import { sendMeetingInviteEmail } from '@/services/emailService';
import { dispatchWebhook } from '@/lib/webhooks';
import { withTenantScope } from '@/lib/orgContext';
import { inCallerTenant } from '@/lib/tenantFilter';
import { meetingInCallerTenant } from '@/lib/meetingAccess';
import { nextRuleOccurrence, type SeriesRule } from '@/lib/meetingSeriesOccurrences';
import { countContexts } from '@/lib/meetingContext';
import { MAX_INTERVAL_WEEKS, MAX_OCCURRENCES_LIMIT } from '@/lib/seriesRule';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import type { Session } from 'next-auth';
import { isValidTimeZone } from '@/lib/timezone';
import { resolveMeetingLink } from '@/lib/meetingRoom';
import { requireCapability } from '@/lib/capabilityGate';
import { withdrawMeetings } from '@/lib/googleCalendarSync';
import { syncSeriesBounded, syncSeriesInBackground } from '@/lib/googleCalendarSeriesSync';
import { durationMinutesField } from '@/lib/meetingDuration';

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

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

const recurrenceSchema = z.object({
  // Exactly ONE of the two contexts (#2013): a project's recurring call, or a
  // standing 1:1 on a mentorship relation. Checked with countContexts() — the
  // same rule Meeting follows — not by the schema, so the error is the shared one.
  projectId: z.string().min(1).optional(),
  relationId: z.string().min(1).optional(),
  // Cadence (#2013): every n weeks, and an optional end — a last date
  // (inclusive, YYYY-MM-DD) and/or a number of meetings. Null clears an end.
  intervalWeeks: z.number().int().min(1).max(MAX_INTERVAL_WEEKS).optional(),
  untilDate: z.string().regex(datePattern).nullable().optional(),
  maxOccurrences: z.number().int().min(1).max(MAX_OCCURRENCES_LIMIT).nullable().optional(),
  title: z.string().min(1),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1),
  timeOfDay: z.string().regex(timePattern),
  // The clock `timeOfDay` is on. The browser sends its own IANA zone; an API
  // client may omit it, in which case the deployment default applies.
  timeZone: z.string().min(1).max(64).optional(),
  meetLink: z.string().url().optional().or(z.literal('')),
  // Length of every occurrence (#1984); omitted → the one default.
  durationMinutes: durationMinutesField,
  // Accepted for backwards compatibility with older clients; occurrences are no
  // longer generated ahead of time, so it no longer influences anything.
  weeksAhead: z.number().int().min(1).max(26).optional(),
  active: z.boolean().optional(),
});

const updateSchema = recurrenceSchema.partial().extend({ id: z.string().min(1) });

const deleteSchema = z.object({ id: z.string().min(1) });

async function ensureProjectAccess(
  user: { id: string; role: string; companyId?: string | null; orgId?: string | null },
  projectId: string
) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, ownerType: true, ownerUserId: true, ownerCompanyId: true, orgId: true },
  });
  // Another tenant's project is a missing one — for an admin too, whose
  // allowance below is "any project of my tenant" (#2542 follow-up).
  if (!project || !(await inCallerTenant(project.orgId, user.orgId))) {
    return { error: NextResponse.json({ error: 'Not found' }, { status: 404 }) as NextResponse };
  }
  if (user.role !== 'ADMIN') {
    const member = await isProjectMember(user, projectId);
    if (!canManageProject(user, project) && !member) {
      return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) as NextResponse };
    }
  }
  return { project };
}

/**
 * The standing-1:1 side (#2013), beside ensureProjectAccess and never loosening
 * it. The relation must be in the caller's tenant (another tenant's is a
 * missing one). `write` — create, edit, cancel — is the relation's MENTOR or an
 * ADMIN; `read` adds the MENTEE, who sees and is reminded of the series but
 * cannot change it. Anyone else gets the 404 a missing relation gets.
 */
async function ensureRelationAccess(
  user: { id: string; role: string; orgId?: string | null },
  relationId: string,
  mode: 'read' | 'write'
): Promise<{ error?: NextResponse; relation?: { id: string; mentorId: string; menteeId: string } }> {
  const relation = await prisma.mentorshipRelation.findFirst({
    where: withinTenant({ id: relationId }, await tenantWhere({ user } as Session)),
    select: { id: true, mentorId: true, menteeId: true },
  });
  const notFound = { error: NextResponse.json({ error: 'Not found' }, { status: 404 }) as NextResponse };
  if (!relation) return notFound;
  const isAdmin = user.role === 'ADMIN';
  const isMentor = relation.mentorId === user.id;
  const isMentee = relation.menteeId === user.id;
  if (!isAdmin && !isMentor && !isMentee) return notFound;
  if (mode === 'write' && !isAdmin && !isMentor) {
    return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) as NextResponse };
  }
  return { relation };
}

/** A calendar date as stored: UTC midnight of YYYY-MM-DD (src/lib/seriesRule.ts). */
function calendarDate(key: string): Date {
  return new Date(`${key}T00:00:00Z`);
}

/** Today's calendar date on the series' own clock — the default cadence anchor. */
function todayIn(timeZone: string | null): Date {
  const key = new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone ?? undefined,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  return calendarDate(key);
}

/**
 * The gate for a write on an EXISTING series, before the row is read: an org
 * with neither module (a MARKETING tenant) is refused up front, exactly as it
 * was when every series was a projects-module write (#2502) — it never learns
 * whether an id exists. The row's own module is checked again after access.
 */
async function eitherSeriesModule(orgId: string | null | undefined) {
  const projects = await requireCapability(orgId, 'projects');
  if (!projects) return null;
  const mentorship = await requireCapability(orgId, 'mentorship');
  return mentorship ? projects : null;
}

/** Which module a series write belongs to: a project's call, or core mentorship. */
function capabilityFor(context: { relationId?: string | null }) {
  return context.relationId ? ('mentorship' as const) : ('projects' as const);
}

/**
 * Who may change or cancel an *existing* series. With a project above it, the
 * project decides (`ensureProjectAccess`). Without one — the project was
 * deleted and the FK is `SetNull`, so the rule outlived it as an orphan — the
 * row falls back to whoever wrote it, or an admin: the same line project-tasks
 * draws for a personal to-do with no project, and the one `meetings/[id]/end`
 * already draws for a series occurrence (#2487). Before this, the orphan
 * case was checked against nothing but "is a mentor", so any mentor in the
 * organisation could cancel anyone's leftover series, or adopt it into a
 * project of their own through PUT and edit it from there.
 *
 * #2013 (a standing 1:1 on a relation, no project) adds its relation branch
 * here; the project branch is never loosened.
 */
async function ensureSeriesAccess(
  user: { id: string; role: string; companyId?: string | null; orgId?: string | null },
  series: { projectId: string | null; relationId?: string | null; createdById: string }
): Promise<{ error?: NextResponse }> {
  if (series.projectId) return ensureProjectAccess(user, series.projectId);
  if (series.relationId) return ensureRelationAccess(user, series.relationId, 'write');
  // An orphan's tenant is its author's (src/lib/meetingTenantRule.ts): another
  // tenant's leftover is a missing row, not one an admin may cancel.
  if (!(await meetingInCallerTenant({}, series.createdById, user.orgId))) {
    return { error: NextResponse.json({ error: 'Not found' }, { status: 404 }) };
  }
  if (user.role === 'ADMIN' || series.createdById === user.id) return {};
  return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
}

/**
 * Drop every `Meeting` row this series ever generated. Nothing writes them any
 * more, but deployments carry years of them; leaving one behind is exactly the
 * ghost entry this rewrite is about. Notes taken in a meeting survive — the
 * `PersonalNote.meetingId` FK is `SetNull`.
 */
async function purgeGeneratedMeetings(seriesId: string) {
  // Each of these rows may still be mirrored on someone's real calendar, and
  // the link rows cascade away with the meeting — so withdraw FIRST (#1986).
  // Bounded; a calendar that does not answer never blocks the save.
  const rows = await prisma.meeting.findMany({ where: { seriesId }, select: { id: true } });
  await withdrawMeetings(rows.map((r) => r.id));
  const { count } = await prisma.meeting.deleteMany({ where: { seriesId } });
  return count;
}

/** Days/time/zone/link that decide *when and where* — a change to any of them moves the meeting. */
function scheduleFingerprint(s: {
  daysOfWeek: unknown;
  timeOfDay: string;
  timeZone: string | null;
  fixedLink: string | null;
  intervalWeeks?: number | null;
  untilDate?: Date | null;
  maxOccurrences?: number | null;
}) {
  const days = Array.isArray(s.daysOfWeek) ? [...(s.daysOfWeek as unknown[])].map(Number).sort((a, b) => a - b) : [];
  // The cadence moves the meeting too (#2013): biweekly → weekly puts it on new dates.
  return `${days.join(',')}|${s.timeOfDay}|${s.timeZone ?? ''}|${s.fixedLink ?? ''}|${s.intervalWeeks ?? 1}|${s.untilDate?.toISOString() ?? ''}|${s.maxOccurrences ?? ''}`;
}

/**
 * Announce the next occurrence to the project's mentees. Only the *next* one is
 * mailed: the rule runs indefinitely, and everything after it is covered by the
 * reminders the cron sends a day before and an hour before
 * (`sendProjectMeetingSeriesReminders`). No RSVP — there is no row to RSVP to.
 */
async function announceNextOccurrence(
  series: SeriesRule & { id: string; projectId: string | null; relationId?: string | null; title: string; timeZone: string | null; durationMinutes: number | null; fixedLink: string | null; active: boolean },
  role: string,
  sessionUserId: string,
  orgId: string | null | undefined,
) {
  if (!series.active || (!series.projectId && !series.relationId)) {
    return { invited: 0, nextOccurrence: null as string | null };
  }

  const next = nextRuleOccurrence(series);
  if (!next) return { invited: 0, nextOccurrence: null };

  // Who is told: a project's call goes to its mentees; a standing 1:1 (#2013)
  // to the one mentee of its relation — the mentor set it up and is not mailed.
  const menteeIds = series.projectId
    ? [
        ...new Set(
          (
            await prisma.projectMember.findMany({
              where: { projectId: series.projectId, role: 'MENTEE' },
              select: { userId: true },
            })
          ).map((m) => m.userId)
        ),
      ]
    : [];

  const relations = await prisma.mentorshipRelation.findMany({
    where: series.relationId
      ? { id: series.relationId, status: 'ACTIVE' }
      : {
          projectId: series.projectId,
          status: 'ACTIVE',
          ...(role === 'MENTOR' ? { mentorId: sessionUserId } : {}),
          ...(menteeIds.length > 0 ? { menteeId: { in: menteeIds } } : {}),
        },
    // `id` is here for the invite's `userId` below — without it this mail ships
    // with no unsubscribe footer and no List-Unsubscribe header. It is the one
    // select this change had to widen; every other send site already had the
    // recipient's id in scope.
    include: { mentee: { select: { id: true, email: true, fullName: true, timezone: true, preferredLanguage: true } } },
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
        // The mentee being invited, not `sessionUserId` (the mentor/admin who
        // created the series and is not mailed here at all).
        userId: rel.mentee.id,
        // Their own language, for the same reason (#1720).
        locale: rel.mentee.preferredLanguage,
        // The links open this tenant's product host (#2495).
        orgId,
        // A series occurrence has no Meeting row, so the UID is the same
        // synthetic id /api/calendar-events and the subscription feed emit for
        // it — the mailed occurrence and the subscribed one are one event.
        icsUid: `series-${series.id}-${next.toISOString()}`,
        durationMinutes: series.durationMinutes,
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
    }, orgId);
  }

  return { invited, nextOccurrence: next.toISOString() };
}

const seriesListSelect = {
  id: true,
  title: true,
  daysOfWeek: true,
  timeOfDay: true,
  timeZone: true,
  fixedLink: true,
  active: true,
  projectId: true,
  relationId: true,
  intervalWeeks: true,
  anchorDate: true,
  untilDate: true,
  maxOccurrences: true,
  createdAt: true,
} as const;

// GET ?projectId= — the project's recurring meetings. Readable by anyone who can
// see the project's internals, mentee members included (#51): "the weekly call is
// Mon+Thu 09:30, here is the link" is exactly what a member needs, and it was
// stored but never surfaced anywhere in the UI.
// GET ?relationId= — a pairing's standing 1:1s (#2013): its mentor, its mentee
// and an admin of its tenant; anyone else gets a 404.
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  return await withTenantScope(session, async () => {
    const params = new URL(request.url).searchParams;
    const projectId = params.get('projectId') || '';
    const relationId = params.get('relationId') || '';
    if (countContexts({ projectId, relationIds: relationId ? [relationId] : [] }) !== 1) {
      return NextResponse.json({ error: 'Exactly one of projectId or relationId is required' }, { status: 400 });
    }
    if (relationId) {
      const access = await ensureRelationAccess(session.user, relationId, 'read');
      if (access.error) return access.error;
      const rows = await prisma.meetingSeries.findMany({
        where: { relationId, active: true },
        orderBy: { createdAt: 'asc' },
        select: seriesListSelect,
      });
      return NextResponse.json({
        series: rows.map((s) => ({ ...s, nextOccurrence: nextRuleOccurrence(s)?.toISOString() ?? null })),
      });
    }

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, ownerType: true, ownerUserId: true, ownerCompanyId: true, orgId: true },
    });
    // Another tenant's project answers like a missing one (#2542 follow-up).
    if (!project || !(await inCallerTenant(project.orgId, session.user.orgId))) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
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
      select: seriesListSelect,
    });
    return NextResponse.json({
      series: series.map((s) => ({
        ...s,
        // The rule alone reads as a puzzle ("Mon, Thu · 09:00" — is that today?);
        // the resolved next occurrence is what people actually want to know, and
        // it is the only form that survives the reader being in another zone.
        nextOccurrence: nextRuleOccurrence(s)?.toISOString() ?? null,
      })),
    });
  });
}

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== 'MENTOR' && session.user.role !== 'ADMIN')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const raw = await request.json().catch(() => null);
  // The capability gate runs FIRST, before validation (e2e/vertical-write-gate):
  // a vertical without the module never even reaches a 400. Which module is the
  // body's to say — a project's call is a projects-module write (#2502), a
  // standing 1:1 (#2013) core mentorship — so only that one field is read raw.
  const rawRelationId =
    raw && typeof raw === 'object' && typeof (raw as { relationId?: unknown }).relationId === 'string'
      ? (raw as { relationId: string }).relationId
      : null;
  const capGate = await requireCapability(session.user.orgId, capabilityFor({ relationId: rawRelationId }));
  if (capGate) return capGate;

  const parsed = recurrenceSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
  }
  const { projectId, relationId, title, daysOfWeek, timeOfDay, timeZone, meetLink, active, durationMinutes } = parsed.data;
  // Exactly one context (#2013) — the rule Meeting follows (#1051), not a second one.
  if (countContexts({ projectId, relationIds: relationId ? [relationId] : [] }) !== 1) {
    return NextResponse.json({ error: 'Exactly one of projectId or relationId is required' }, { status: 400 });
  }

  return await withTenantScope(session, async () => {
    const access = relationId
      ? await ensureRelationAccess(session.user, relationId, 'write')
      : await ensureProjectAccess(session.user, projectId!);
    if (access.error) return access.error;
    const zone = isValidTimeZone(timeZone) ? timeZone : null;

    // A series' audience is derived from project membership at announce time
    // and can grow over the series' life, so its head-count is genuinely
    // unknown here — `inviteeCount: null`, which the resolver books against the
    // allowance as a small group (lib/jaasAllowance.ts). It used to mean "never
    // a JaaS room", which put every recurring series on a host that cuts an
    // embedded call off after five minutes (#2011).
    const fixedLink = await resolveMeetingLink({
      pastedLink: meetLink,
      inviteeCount: null,
      orgId: session.user.orgId,
    });
    const series = await prisma.meetingSeries.create({
      data: {
        projectId: projectId ?? null,
        relationId: relationId ?? null,
        title,
        daysOfWeek,
        timeOfDay,
        timeZone: zone,
        // The cadence (#2013). The anchor is today on the series' own clock, so
        // "every 2 weeks" starts with this week.
        intervalWeeks: parsed.data.intervalWeeks ?? 1,
        anchorDate: todayIn(zone),
        untilDate: parsed.data.untilDate ? calendarDate(parsed.data.untilDate) : null,
        maxOccurrences: parsed.data.maxOccurrences ?? null,
        durationMinutes: durationMinutes ?? null,
        fixedLink,
        active: active ?? true,
        createdById: session.user.id,
      },
    });

    const announced = await announceNextOccurrence(series, session.user.role, session.user.id, session.user.orgId);
    // One recurring event per connected member (#2654) — in the background, so
    // the save never waits on Google.
    syncSeriesInBackground(series);
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
  const earlyGate = await eitherSeriesModule(session.user.orgId);
  if (earlyGate) return earlyGate;

  return await withTenantScope(session, async () => {
    const parsed = updateSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
    }
    const { id, weeksAhead: _weeksAhead, ...incoming } = parsed.data;

    const current = await prisma.meetingSeries.findUnique({ where: { id } });
    if (!current) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    // The row being changed comes first (#2487). It used to be checked only
    // against the *target* project, so an orphaned series (project deleted, FK
    // SetNull) could be adopted by any mentor into a project of their own, and a
    // move between projects never asked whether you could touch the one it was
    // leaving.
    const currentAccess = await ensureSeriesAccess(session.user, current);
    if (currentAccess.error) return currentAccess.error;
    // The row's own module decides (#2502, #2013): a project's call is a
    // projects-module write, a standing 1:1 is core mentorship. After the access
    // check, which answers another tenant's row with the 404 a missing one gets —
    // so the gate's 403 can never tell a foreign caller the row exists.
    const capGate = await requireCapability(session.user.orgId, capabilityFor(current));
    if (capGate) return capGate;
    // A series never changes context: a 1:1 does not become a project call.
    if (
      (incoming.relationId !== undefined && incoming.relationId !== current.relationId) ||
      (current.relationId && incoming.projectId !== undefined)
    ) {
      return NextResponse.json({ error: 'A series cannot move between a relation and a project' }, { status: 400 });
    }

    if (!current.relationId) {
      const targetProjectId = incoming.projectId ?? current.projectId;
      if (!targetProjectId) return NextResponse.json({ error: 'projectId is required' }, { status: 400 });
      if (targetProjectId !== current.projectId) {
        const access = await ensureProjectAccess(session.user, targetProjectId);
        if (access.error) return access.error;
      }
    }

    const data: {
      projectId?: string;
      title?: string;
      daysOfWeek?: number[];
      timeOfDay?: string;
      timeZone?: string | null;
      durationMinutes?: number;
      fixedLink?: string | null;
      active?: boolean;
      intervalWeeks?: number;
      untilDate?: Date | null;
      maxOccurrences?: number | null;
    } = {};
    if (incoming.projectId !== undefined) data.projectId = incoming.projectId;
    if (incoming.title !== undefined) data.title = incoming.title;
    if (incoming.daysOfWeek !== undefined) data.daysOfWeek = incoming.daysOfWeek;
    if (incoming.timeOfDay !== undefined) data.timeOfDay = incoming.timeOfDay;
    if (incoming.timeZone !== undefined) data.timeZone = isValidTimeZone(incoming.timeZone) ? incoming.timeZone : null;
    if (incoming.meetLink !== undefined) data.fixedLink = incoming.meetLink || null;
    if (incoming.durationMinutes !== undefined) data.durationMinutes = incoming.durationMinutes;
    if (incoming.active !== undefined) data.active = incoming.active;
    if (incoming.intervalWeeks !== undefined) data.intervalWeeks = incoming.intervalWeeks;
    if (incoming.untilDate !== undefined) data.untilDate = incoming.untilDate ? calendarDate(incoming.untilDate) : null;
    if (incoming.maxOccurrences !== undefined) data.maxOccurrences = incoming.maxOccurrences;

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
      ? await announceNextOccurrence(updated, session.user.role, session.user.id, session.user.orgId)
      : {
          invited: 0,
          nextOccurrence: updated.active
            ? nextRuleOccurrence(updated)?.toISOString() ?? null
            : null,
        };

    // The mirrored recurring event follows the rule (#2654): an active series is
    // PATCHed on the event it already made (a rename, a move, another project's
    // members), a deactivated one is withdrawn before we answer — bounded.
    if (updated.active) syncSeriesInBackground(updated);
    else await syncSeriesBounded(updated);

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
  const earlyGate = await eitherSeriesModule(session.user.orgId);
  if (earlyGate) return earlyGate;

  return await withTenantScope(session, async () => {
    const parsed = deleteSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

    const current = await prisma.meetingSeries.findUnique({ where: { id: parsed.data.id } });
    if (!current) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    // Every row, including one whose project is gone — that case used to skip
    // straight to the purge (#2487).
    const access = await ensureSeriesAccess(session.user, current);
    if (access.error) return access.error;
    // The gate is about the actor's org and the row's module (#2502, #2013): a
    // series that lost its project is still a projects leftover (#2487), a
    // standing 1:1 is core mentorship. After the access check, so a foreign
    // tenant's row stays a 404.
    const capGate = await requireCapability(session.user.orgId, capabilityFor(current));
    if (capGate) return capGate;

    const removedMeetings = await purgeGeneratedMeetings(parsed.data.id);
    const series = await prisma.meetingSeries.update({
      where: { id: parsed.data.id },
      data: { active: false },
    });
    // Off every member's calendar before we answer (#2654), through the same
    // bounded withdrawal the one-off meetings use.
    await syncSeriesBounded(series);
    return NextResponse.json({ ok: true, series, removedMeetings });
  });
}
