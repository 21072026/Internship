import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { enforceRateLimit } from '@/lib/rateLimit';
import { withRequestScope } from '@/lib/requestContext';
import { captureError, errorTrackingEnabled } from '@/lib/errorTracking';

// Browser error relay (#1600): `lib/browserErrorReporter.ts` POSTs here, and
// this route forwards through the one sender `lib/errorTracking.ts`. The body
// is never trusted — every string is masked again by the event builder
// (`errorTrackingRule.ts`), and role/org come from the session, not the body.
// With no ERROR_TRACKING_DSN it answers 204 and does nothing.

const MAX_BODY_BYTES = 16 * 1024;

const schema = z.object({
  name: z.string().max(200).optional().default('Error'),
  message: z.string().max(2000).optional().default(''),
  stack: z.string().max(8000).optional(),
  scope: z.string().max(64).optional().default('window'),
  digest: z.string().max(64).optional(),
  path: z.string().max(1024).optional().default(''),
});

export async function POST(request: Request) {
  return withRequestScope(request, async () => {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (!errorTrackingEnabled()) return new NextResponse(null, { status: 204 });
    const limited = enforceRateLimit(request, 'telemetry-errors', { limit: 30, windowMs: 10 * 60 * 1000, subject: session.user.id });
    if (limited) return limited;

    const text = await request.text().catch(() => '');
    if (!text || text.length > MAX_BODY_BYTES) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    const p = parsed.data;

    await captureError({
      error: { name: p.name, message: p.message, stack: p.stack },
      platform: 'javascript',
      tags: {
        source: 'browser',
        route: p.path,
        scope: p.scope,
        digest: p.digest,
        role: session.user.role,
        orgId: session.user.orgId ?? undefined,
      },
    });
    return new NextResponse(null, { status: 204 });
  });
}
