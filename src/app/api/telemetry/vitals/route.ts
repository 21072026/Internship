import { NextResponse } from 'next/server';
import { z } from 'zod';
import { enforceRateLimit } from '@/lib/rateLimit';
import { withRequestScope } from '@/lib/requestContext';
import { logger } from '@/lib/logger';
import { routeTemplate, webVitalsSampleRate, WEB_VITAL_NAMES, WEB_VITAL_RATINGS } from '@/lib/webVitalsRule';

// Core Web Vitals relay (#1593): `WebVitalsReporter` beacons a sample here and
// this route writes ONE structured log line (`web_vital`) — the container log is
// where the request id (#1601) already ties lines together, and it needs no
// table. Anonymous on purpose: the landing page is the first screen a mobile
// visitor waits for. What it may carry is fixed by `webVitalsRule.ts`; the route
// template is re-derived here because a body is never trusted. With
// NEXT_PUBLIC_WEB_VITALS_SAMPLE_RATE unset (inlined at build) it drops
// everything with a 204.

const RATE = webVitalsSampleRate(process.env.NEXT_PUBLIC_WEB_VITALS_SAMPLE_RATE);
const MAX_BODY_BYTES = 2048;

const schema = z.object({
  name: z.enum(WEB_VITAL_NAMES),
  value: z.number().finite().min(0).max(600_000),
  rating: z.enum(WEB_VITAL_RATINGS).optional(),
  route: z.string().max(1024),
  navigationType: z.string().max(32).regex(/^[a-z_-]*$/).optional(),
});

export async function POST(request: Request) {
  return withRequestScope(request, async () => {
    if (RATE <= 0) return new NextResponse(null, { status: 204 });
    const limited = enforceRateLimit(request, 'telemetry-vitals', { limit: 60, windowMs: 10 * 60 * 1000 });
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
    const s = parsed.data;
    logger.info('web_vital', {
      metric: s.name,
      // CLS is unitless and small; everything else is milliseconds.
      value: s.name === 'CLS' ? Math.round(s.value * 1000) / 1000 : Math.round(s.value),
      rating: s.rating,
      route: routeTemplate(s.route),
      navigationType: s.navigationType,
    });
    return new NextResponse(null, { status: 204 });
  });
}
