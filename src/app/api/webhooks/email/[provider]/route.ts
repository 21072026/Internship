import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { enforceRateLimit } from '@/lib/rateLimit';
import { logger } from '@/lib/logger';
import { withRequestScope } from '@/lib/requestContext';
import { ingestDeliveryEvents } from '@/lib/emailSuppression';
import { isEmailWebhookProvider, normaliseWebhookBody, presentedSecrets, webhookCredentialOk } from '@/lib/emailSuppressionRule';

export const dynamic = 'force-dynamic';

// A webhook body is a list of short event objects; anything near this is not one.
const MAX_BODY_BYTES = 256 * 1024;

function equal(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// POST — the mail provider's bounce / complaint webhook (#1692).
//
// A provider holds no session: the credential is the shared secret
// EMAIL_WEBHOOK_SECRET, presented as `X-Webhook-Secret`, a bearer token, or the
// password of HTTP Basic auth (whichever the provider can send). Without the
// secret configured the route FAILS CLOSED in production — the inbound-email
// rule (#870): an open webhook would let anyone suppress any address,
// a password reset included. Rate-limited per IP before anything is read.
//
// The body is normalised by the provider's own reader
// (src/lib/emailSuppressionRule.ts § normaliseWebhookBody); events that say
// nothing about the address (delivered, opened, …) are acknowledged and
// ignored. Idempotent on the provider's event id: a retried delivery answers
// 200 with `duplicates` and changes nothing. No outbound call is made here.
export async function POST(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  return withRequestScope(request, async () => {
    // Providers deliver in bursts from a handful of IPs.
    const limited = enforceRateLimit(request, 'email-webhook', { limit: 600, windowMs: 60 * 1000 });
    if (limited) return limited;
    const { provider } = await params;
    if (!isEmailWebhookProvider(provider)) return NextResponse.json({ error: 'Unknown provider' }, { status: 404 });
    const ok = webhookCredentialOk(
      { expected: process.env.EMAIL_WEBHOOK_SECRET || undefined, presented: presentedSecrets(request.headers), production: process.env.NODE_ENV === 'production' },
      equal,
    );
    if (!ok) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const raw = await request.text().catch(() => '');
    if (raw.length > MAX_BODY_BYTES) return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return NextResponse.json({ error: 'Invalid payload', code: 'invalid_payload' }, { status: 400 });
    }
    const parsed = normaliseWebhookBody(provider, body);
    if (!parsed.ok) return NextResponse.json({ error: 'Invalid payload', code: parsed.error }, { status: 400 });

    try {
      const summary = await ingestDeliveryEvents(parsed.events);
      // Counts only — never an address in a log line.
      logger.info('email_webhook.received', { provider, ...summary, ignored: parsed.ignored });
      return NextResponse.json({ ok: true, ...summary, ignored: parsed.ignored });
    } catch (e) {
      // 500 so the provider retries; the event-id key makes the retry safe.
      logger.error('email_webhook.failed', { provider, error: e instanceof Error ? e.message : String(e) });
      return NextResponse.json({ error: 'Could not record the events' }, { status: 500 });
    }
  });
}
