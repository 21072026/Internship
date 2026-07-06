import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { hasConsent } from '@/lib/consent';

// Cap dwell time per hit so a backgrounded tab / clock skew can't inflate the
// "time on site" total (30 min is well beyond a single active page view).
const MAX_DURATION_SEC = 30 * 60;

const bodySchema = z.object({
  // App-relative path only; query string is stripped and length capped below.
  path: z.string().min(1).max(512),
  durationSec: z.number().int().min(0).max(24 * 60 * 60).optional(),
});

// Normalize to an app-relative path without query/hash, so the report groups by
// page and never stores anything sensitive from the query string.
function cleanPath(raw: string): string {
  let p = raw.split('?')[0].split('#')[0].trim();
  if (!p.startsWith('/')) p = `/${p}`;
  return p.slice(0, 256);
}

// POST — record a page view for the signed-in user. No-op (204) unless the user
// has granted ACTIVITY_TRACKING consent, so tracking is strictly opt-in.
// Sent via navigator.sendBeacon on route change, so it must stay lightweight.
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return new NextResponse(null, { status: 204 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return new NextResponse(null, { status: 204 });

  // Don't track while impersonating — that activity isn't the user's own.
  if (session.user.impersonatorId) return new NextResponse(null, { status: 204 });

  if (!(await hasConsent(session.user.id, 'ACTIVITY_TRACKING'))) {
    return new NextResponse(null, { status: 204 });
  }

  const duration = Math.min(parsed.data.durationSec ?? 0, MAX_DURATION_SEC);
  try {
    await prisma.$transaction([
      prisma.pageView.create({
        data: { userId: session.user.id, path: cleanPath(parsed.data.path), durationSec: duration },
      }),
      prisma.user.update({ where: { id: session.user.id }, data: { lastSeenAt: new Date() } }),
    ]);
  } catch {
    // Never let telemetry break navigation.
  }
  return new NextResponse(null, { status: 204 });
}
