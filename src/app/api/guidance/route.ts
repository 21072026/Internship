import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { withTenantScope } from '@/lib/orgContext';
import { readTourStates, recordTourOutcome } from '@/lib/guidance';
import { TOURS, tourById, tourGuidanceKey } from '@/lib/tours';

// The signed-in person's own tour state (#2067, src/lib/tours.ts).
//
// ONLY the session user's rows, read or written: the id comes from the
// session and there is no field that could name anybody else — the body is
// `.strict()`, so a `userId` in it is a 400, an ADMIN's included. A tour id
// must be one of the registry's; nothing else reaches the table.

const postSchema = z
  .object({
    tourId: z.string().min(1).max(64),
    outcome: z.enum(['completed', 'dismissed']),
  })
  .strict();

// GET — { tours: { "<tourId>": "new" | "completed" | "dismissed" } } for every
// registered tour.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return await withTenantScope(session, async () => {
    const keys = TOURS.map((t) => tourGuidanceKey(t.id));
    const states = await readTourStates(session.user.id, keys);
    return NextResponse.json({ tours: Object.fromEntries(TOURS.map((t) => [t.id, states[tourGuidanceKey(t.id)]])) });
  });
}

// POST { tourId, outcome } — the person finished ("completed") or skipped
// ("dismissed") a tour; either way it is not offered to them again.
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const parsed = postSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  const tour = tourById(parsed.data.tourId);
  if (!tour) return NextResponse.json({ error: 'Unknown tour' }, { status: 400 });
  return await withTenantScope(session, async () => {
    await recordTourOutcome(session.user.id, tourGuidanceKey(tour.id), parsed.data.outcome);
    return NextResponse.json({ tourId: tour.id, state: parsed.data.outcome });
  });
}
