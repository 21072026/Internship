import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { pushConfigured } from '@/lib/webPush';
import { enforceRateLimit } from '@/lib/rateLimit';
import { listPushDevices, revokePushDevice } from '@/lib/pushDevices';
import { logActivity } from '@/lib/activity';

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

/**
 * GET — the browsers this account has granted push to (#1716).
 *
 * Returns `{ enabled, devices }` where a device is `{ id, label, createdAt,
 * lastSeenAt, current }` and **nothing else**: `endpoint`, `p256dh` and `auth`
 * are the credential for pushing to that browser and the list needs none of
 * them (the allowlist that guarantees it lives in `listPushDevices`).
 *
 * "Which of these is the browser I am sitting at?" cannot be answered from the
 * session — a push subscription belongs to a browser profile, not to a person —
 * so the page sends the endpoint its own service worker holds in the
 * `x-push-endpoint` header and the match is made server-side. A header rather
 * than a query parameter deliberately: a query string ends up in access logs,
 * and this value, while not usable on its own, is half of a delivery credential.
 *
 * `enabled` and `devices` are two **independent** facts and are reported as
 * such: `enabled` says whether this deployment can still deliver push (it is
 * false with no VAPID keys), and the rows are returned either way. The page
 * needs both, and hides the section only when push is off *and* nothing is on
 * record — with rows it lists them plus a note that nothing is being delivered,
 * because a deployment that lost its keys must not strand subscriptions their
 * owner can no longer see or revoke.
 */
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const header = request.headers.get('x-push-endpoint');
  // Shape-checked, not trusted: it is only ever compared against rows this user
  // already owns, and anything malformed simply marks no row as current.
  const currentEndpoint =
    header && header.length <= 500 && header.startsWith('https://') ? header : null;

  const devices = await listPushDevices(session.user.id, currentEndpoint);
  return NextResponse.json({ enabled: pushConfigured(), devices });
}

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

/**
 * DELETE — drop a subscription. Two callers, both scoped to the caller's own
 * rows so knowing someone else's endpoint or id does not let you silence them:
 *
 *   `?id=<id>`  — the account page revoking one listed browser (#1716). A row
 *                 that is not this user's, or that is already gone (the push
 *                 service rejected it, or retention swept it), is a 404 — the
 *                 page then says the browser is no longer subscribed rather than
 *                 claiming the user just revoked something.
 *   JSON body   — the service worker's own unsubscribe (`{ endpoint }`), which
 *                 is idempotent by design: the browser is telling us it has
 *                 stopped listening, and it being right twice is not an error.
 */
export async function DELETE(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const id = new URL(request.url).searchParams.get('id');
  if (id) {
    const revoked = await revokePushDevice(id, session.user.id);
    if (!revoked) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    await logActivity({
      action: 'account.push_device_revoked',
      level: 'warning',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'PushSubscription',
      targetId: id,
      request,
    });
    return NextResponse.json({ ok: true });
  }

  const parsed = unsubscribeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

  await prisma.pushSubscription.deleteMany({
    where: { endpoint: parsed.data.endpoint, userId: session.user.id },
  });
  return NextResponse.json({ ok: true });
}
