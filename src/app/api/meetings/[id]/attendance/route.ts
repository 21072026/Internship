import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { withTenantScope } from '@/lib/orgContext';
import { enforceRateLimit } from '@/lib/rateLimit';
import { prisma } from '@/lib/prisma';
import { RECORDABLE_ATTENDANCE, recordAttendance, resolveAttendanceTarget, type AttendanceTarget } from '@/lib/meetingAttendance';

// Who turned up to a pair's meeting (#2014). Both id shapes the end route
// takes — a Meeting cuid, or `<seriesId>:<ISO instant>` for a recurring
// occurrence with no row. Either participant (or an admin) may record; the
// mentor's record wins (src/lib/meetingAttendance.ts). LATE_CANCEL cannot be
// posted: it is derived when a meeting is cancelled late.

const bodySchema = z
  .object({
    entries: z
      .array(z.object({ userId: z.string().min(1).max(64), state: z.enum(RECORDABLE_ATTENDANCE), note: z.string().max(500).optional().nullable() }).strict())
      .min(1)
      .max(2),
  })
  .strict();

function readId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

const STATUS = { not_found: 404, not_a_pair: 400, not_started: 409, cancelled: 409 } as const;

async function rowsFor(target: AttendanceTarget) {
  return prisma.meetingAttendance.findMany({
    where: target.meetingId
      ? { meetingId: target.meetingId }
      : { seriesId: target.seriesId, occurrenceAt: target.occurrenceAt },
    select: { userId: true, state: true, note: true, recordedById: true, recordedAt: true },
  });
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const id = readId((await params).id);
  return withTenantScope(session, async () => {
    const resolved = await resolveAttendanceTarget(session.user, id);
    if ('error' in resolved) return NextResponse.json({ error: resolved.error }, { status: STATUS[resolved.error] });
    const { target } = resolved;
    return NextResponse.json({ participants: [target.mentorId, target.menteeId], attendance: await rowsFor(target) });
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const limited = enforceRateLimit(request, 'meeting-attendance', { limit: 30, windowMs: 60_000 });
  if (limited) return limited;
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
  const id = readId((await params).id);
  return withTenantScope(session, async () => {
    const resolved = await resolveAttendanceTarget(session.user, id);
    if ('error' in resolved) return NextResponse.json({ error: resolved.error }, { status: STATUS[resolved.error] });
    const result = await recordAttendance(resolved.target, session.user, parsed.data.entries);
    if (result.rejected > 0 && result.saved === 0 && result.kept === 0) {
      return NextResponse.json({ error: 'not_a_participant', code: 'not_a_participant' }, { status: 400 });
    }
    return NextResponse.json({ result, attendance: await rowsFor(resolved.target) });
  });
}
