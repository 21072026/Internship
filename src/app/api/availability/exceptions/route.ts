import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { mayWriteAvailabilityFor, mentorToday, writableMentorId } from '@/lib/availabilityAccess';

// Away windows (#2001): a stretch of days on which none of a mentor's hours are
// offered. Same authorization as the slots themselves — the mentor, or an ADMIN
// for a mentor of their own org (src/lib/availabilityAccess.ts). Readers who
// book (a paired mentee, the directory) get the dates through
// GET /api/availability, without the reason.

const DATE = /^\d{4}-\d{2}-\d{2}$/;
// A year is a sabbatical, not an away window; past that, stop offering hours.
const MAX_DAYS = 366;

async function zoneOf(mentorId: string) {
  return (await prisma.user.findUnique({ where: { id: mentorId }, select: { timezone: true } }))?.timezone ?? null;
}

// GET [?mentorId=] — your own current and upcoming away windows, or (ADMIN) a
// mentor's of your org.
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const mentorId = await writableMentorId(session, new URL(request.url).searchParams.get('mentorId'));
  if (!mentorId) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const exceptions = await prisma.availabilityException.findMany({
    where: { mentorId, endDate: { gte: mentorToday(await zoneOf(mentorId)) } },
    orderBy: { startDate: 'asc' },
  });
  return NextResponse.json({ exceptions });
}

const schema = z.object({
  startDate: z.string().regex(DATE),
  endDate: z.string().regex(DATE),
  reason: z.string().trim().max(120).nullish(),
  mentorId: z.string().min(1).optional(),
});

// POST — declare an away window. Both ends inclusive, calendar dates read in
// the mentor's own zone when slots are expanded.
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  const mentorId = await writableMentorId(session, parsed.data.mentorId);
  if (!mentorId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const startDate = new Date(`${parsed.data.startDate}T00:00:00Z`);
  const endDate = new Date(`${parsed.data.endDate}T00:00:00Z`);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime()) || endDate < startDate) {
    return NextResponse.json({ error: 'The end date must not be before the start date' }, { status: 400 });
  }
  if ((endDate.getTime() - startDate.getTime()) / 86_400_000 >= MAX_DAYS) {
    return NextResponse.json({ error: 'An away window may last at most a year' }, { status: 400 });
  }
  if (endDate < mentorToday(await zoneOf(mentorId))) {
    return NextResponse.json({ error: 'That window has already passed' }, { status: 400 });
  }
  const exception = await prisma.availabilityException.create({
    data: { mentorId, startDate, endDate, reason: parsed.data.reason || null },
  });
  return NextResponse.json({ exception }, { status: 201 });
}

// DELETE ?id= — end an away window early, or call it off.
export async function DELETE(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const id = new URL(request.url).searchParams.get('id') || '';
  const row = await prisma.availabilityException.findUnique({ where: { id }, select: { id: true, mentorId: true } });
  if (!row || !(await mayWriteAvailabilityFor(session, row.mentorId))) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  await prisma.availabilityException.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
