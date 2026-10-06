import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { writableMentorId } from '@/lib/availabilityAccess';
import { POLICY_LIMITS } from '@/lib/bookingPolicyRule';

// A mentor's booking rules (#2003): the one row the "Booking rules" card edits.
// Same authorization as the slots: the mentor, or an ADMIN for a mentor of
// their own org (src/lib/availabilityAccess.ts). Enforcement lives in
// src/lib/bookingPolicy.ts.

const EMPTY = { minNoticeMinutes: null, bufferMinutes: null, maxPerWeek: null, maxPerMonth: null, defaultSlotMinutes: null };
const SELECT = { minNoticeMinutes: true, bufferMinutes: true, maxPerWeek: true, maxPerMonth: true, defaultSlotMinutes: true } as const;

// GET [?mentorId=] — your rules, or (ADMIN) a mentor's of your org.
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const mentorId = await writableMentorId(session, new URL(request.url).searchParams.get('mentorId'));
  if (!mentorId) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const policy = await prisma.mentorBookingPolicy.findUnique({ where: { mentorId }, select: SELECT });
  return NextResponse.json({ policy: policy ?? EMPTY });
}

const bounded = (k: keyof typeof POLICY_LIMITS) => z.number().int().min(POLICY_LIMITS[k].min).max(POLICY_LIMITS[k].max).nullable();

const putSchema = z
  .object({
    mentorId: z.string().min(1).optional(),
    minNoticeMinutes: bounded('minNoticeMinutes'),
    bufferMinutes: bounded('bufferMinutes'),
    maxPerWeek: bounded('maxPerWeek'),
    maxPerMonth: bounded('maxPerMonth'),
    defaultSlotMinutes: bounded('defaultSlotMinutes'),
  })
  .strict()
  // A monthly cap below the weekly one would make the weekly one a lie.
  .refine((v) => v.maxPerWeek == null || v.maxPerMonth == null || v.maxPerMonth >= v.maxPerWeek, { path: ['maxPerMonth'], message: 'below_weekly' });

// PUT — replace the rules. Every field is sent; null clears that rule.
export async function PUT(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const parsed = putSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed', issues: parsed.error.issues }, { status: 400 });
  const { mentorId: requested, ...rules } = parsed.data;
  const mentorId = await writableMentorId(session, requested);
  if (!mentorId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const policy = await prisma.mentorBookingPolicy.upsert({
    where: { mentorId },
    create: { mentorId, ...rules },
    update: rules,
    select: SELECT,
  });
  return NextResponse.json({ policy });
}
