import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { inCallerTenant } from '@/lib/tenantFilter';
import { busyWindows } from '@/lib/busyWindows';
import { providerBusy } from '@/lib/calendarFreeBusy';
import { mergeWindows } from '@/lib/busyWindowsRule';
import { findPolicyViolation, loadBookingPolicy } from '@/lib/bookingPolicy';
import { widenForBuffer } from '@/lib/bookingPolicyRule';
import { liveSlotsWhere, mentorToday } from '@/lib/availabilityAccess';
import { suggestTimes, type Suggestion } from '@/lib/suggestTimes';
import { DEFAULT_MEETING_MINUTES, MIN_MEETING_MINUTES } from '@/lib/meetingDuration';

// GET ?relationId=&duration=&count= — times that work for both people of a
// relation (#1999): the mentor's posted hours, minus everyone's busy windows,
// inside 08:00–20:00 on each person's own clock, within the mentor's booking
// rules (#2003). The arithmetic is src/lib/suggestTimes.ts (pure).
//
// Who may ask: an ADMIN of the org, the pair's mentor, or the mentee of an
// ACTIVE relation — the same set that may book there. The answer is instants
// and each person's zone, never anybody's calendar: a busy hour is simply not
// offered, with no title and no reason attached.

const WEEKS = 3;
const HORIZON_MS = (WEEKS * 7 + 1) * 24 * 60 * 60_000;
const MAX_COUNT = 10;
// Checking a cap costs queries; past this many candidates the answer is "full".
const MAX_POLICY_CHECKS = 40;

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const params = new URL(request.url).searchParams;
  const relationId = params.get('relationId') ?? '';
  const count = Math.min(Math.max(parseInt(params.get('count') ?? '5', 10) || 5, 1), MAX_COUNT);
  const requestedDuration = parseInt(params.get('duration') ?? '', 10);

  return withTenantScope(session, async () => {
    const rel = await prisma.mentorshipRelation.findUnique({
      where: { id: relationId },
      select: {
        orgId: true,
        status: true,
        mentorId: true,
        menteeId: true,
        mentor: { select: { fullName: true, timezone: true } },
        mentee: { select: { fullName: true, timezone: true } },
      },
    });
    // Another tenant's relation reads exactly like a missing one.
    if (!rel || !(await inCallerTenant(rel.orgId, resolveOrgId(session)))) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const me = session.user;
    const allowed = me.role === 'ADMIN' || me.id === rel.mentorId || (me.role === 'MENTEE' && me.id === rel.menteeId && rel.status === 'ACTIVE');
    if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const policy = await loadBookingPolicy(prisma, rel.mentorId);
    const durationMinutes = Number.isFinite(requestedDuration)
      ? Math.min(Math.max(requestedDuration, Math.max(MIN_MEETING_MINUTES, 15)), 240)
      : policy?.defaultSlotMinutes ?? DEFAULT_MEETING_MINUTES;

    const now = new Date();
    const horizon = new Date(now.getTime() + HORIZON_MS);
    const today = mentorToday(rel.mentor.timezone, now);
    // Both people's real calendars count (#1997) — as bare windows, like ours.
    const external = await providerBusy([rel.mentorId, rel.menteeId], now, horizon);
    const [slots, exceptions, mentorBusy, menteeBusy] = await Promise.all([
      prisma.availabilitySlot.findMany({ where: liveSlotsWhere(rel.mentorId, today), select: { id: true, weekday: true, startTime: true, endTime: true, date: true } }),
      prisma.availabilityException.findMany({ where: { mentorId: rel.mentorId, endDate: { gte: today } }, select: { startDate: true, endDate: true } }),
      busyWindows(prisma, [rel.mentorId], now, horizon, { external }),
      busyWindows(prisma, [rel.menteeId], now, horizon, { external }),
    ]);
    const result = suggestTimes({
      slots,
      mentorZone: rel.mentor.timezone,
      exceptions,
      attendeeZones: [rel.mentor.timezone, rel.mentee.timezone],
      busy: mergeWindows([...widenForBuffer(mentorBusy, policy?.bufferMinutes), ...menteeBusy]),
      from: now,
      weeks: WEEKS,
      durationMinutes,
      minNoticeMinutes: policy?.minNoticeMinutes,
    });

    // The caps (#2003) need counts, so they are applied here, to the ranked
    // list, stopping as soon as there are enough.
    let suggestions: Suggestion[] = result.suggestions.slice(0, count);
    let reason: string | null = result.reason;
    if (policy && (policy.maxPerWeek || policy.maxPerMonth) && result.suggestions.length > 0) {
      suggestions = [];
      for (const s of result.suggestions.slice(0, MAX_POLICY_CHECKS)) {
        const violation = await findPolicyViolation(prisma, { mentorId: rel.mentorId, start: new Date(s.startISO), end: new Date(s.endISO), now, policy, external });
        if (!violation) suggestions.push(s);
        if (suggestions.length >= count) break;
      }
      if (suggestions.length === 0) reason = 'limit_reached';
    }

    return NextResponse.json({
      durationMinutes,
      suggestions,
      reason,
      people: [
        { name: rel.mentor.fullName, timezone: rel.mentor.timezone },
        { name: rel.mentee.fullName, timezone: rel.mentee.timezone },
      ],
    });
  });
}
