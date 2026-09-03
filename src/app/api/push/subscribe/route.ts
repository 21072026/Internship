import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { pushConfigured } from '@/lib/webPush';
import { enforceRateLimit } from '@/lib/rateLimit';

// A push endpoint is a URL issued by the browser's push service. Only https, and
// bounded by the column width — an endpoint is never user-authored text, so
// anything outside that shape is a bug or an attempt to write junk rows.
const subscribeSchema = z.object({
  endpoint: z.string().url().startsWith('https://').max(500),
  keys: z.object({
    p256dh: z.string().min(1).max(255),
    auth: z.string().min(1).max(255),
  }),
});

const unsubscribeSchema = z.object({ endpoint: z.string().min(1).max(500) });

// POST — store (or refresh) this browser's push subscription for the signed-in
// user (#1464). Idempotent: `endpoint` is unique, so a browser that re-subscribes
// updates its row rather than adding a second one that would deliver the same
// notification twice.
export async function POST(request: Request) {
    // 10 per 15 minutes covers normal browser re-subscriptions without permitting automated churn.
  const limited = enforceRateLimit(request, 'push-subscribe', { limit: 10, windowMs: 15 * 60 * 1000 });
  if (limited) return limited;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!pushConfigured()) return NextResponse.json({ error: 'Push not configured' }, { status: 503 });

  const parsed = subscribeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

  const { endpoint, keys } = parsed.data;
  // Truncated rather than rejected: a long UA string is cosmetic metadata for the
  // device list, never a reason to refuse a valid subscription.
  const userAgent = (request.headers.get('user-agent') || '').slice(0, 255) || null;

  // An endpoint can legitimately change hands — the same browser profile signing
  // in as somebody else — so the owner is part of the update, not just the create.
  await prisma.pushSubscription.upsert({
    where: { endpoint },
    create: { userId: session.user.id, endpoint, p256dh: keys.p256dh, auth: keys.auth, userAgent },
    update: {
      userId: session.user.id,
      p256dh: keys.p256dh,
      auth: keys.auth,
      userAgent,
      failureCount: 0,
      lastSeenAt: new Date(),
    },
  });

  return NextResponse.json({ ok: true });
}

// DELETE — drop this browser's subscription (the user switched notifications off,
// or the browser told us the subscription changed). Scoped to the caller's own
// rows, so knowing someone else's endpoint does not let you silence them.
export async function DELETE(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = unsubscribeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

  await prisma.pushSubscription.deleteMany({
    where: { endpoint: parsed.data.endpoint, userId: session.user.id },
  });
  return NextResponse.json({ ok: true });
}
