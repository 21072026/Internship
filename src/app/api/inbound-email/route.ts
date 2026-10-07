import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { z } from 'zod';
import { routeInboundMail } from '@/lib/crmBcc';
import { enforceRateLimit } from '@/lib/rateLimit';

const schema = z.object({
  to: z.string().min(1),
  from: z.string().min(1),
  text: z.string().max(20000).optional().default(''),
  messageId: z.string().max(998).optional(),
  // BCC-to-CRM (#2809) only; a thread reply ignores them.
  cc: z.string().max(20000).optional(),
  subject: z.string().max(2000).optional(),
  date: z.string().max(200).optional(),
  // A message forwarded as an attachment (#2815); an inline forward is read from `text`.
  forwarded: z
    .object({
      from: z.string().min(1).max(500),
      date: z.string().max(200).nullable().default(null),
      subject: z.string().max(2000).nullable().default(null),
      messageId: z.string().max(998).nullable().default(null),
    })
    .optional(),
});

function secretOk(request: Request): boolean {
  const expected = process.env.INBOUND_SECRET;
  // Unconfigured used to mean "let it through and rely on the HMAC token gate"
  // — two fail-opens stacked, because that gate itself fell back to a public
  // 'dev-secret' (#870). The HMAC no longer has a fallback, and in production
  // this shared secret is required outright; dev and CI keep the lenient path.
  if (!expected) return process.env.NODE_ENV !== 'production';
  const got = request.headers.get('x-inbound-secret') || '';
  try {
    return got.length === expected.length && timingSafeEqual(Buffer.from(got), Buffer.from(expected));
  } catch {
    return false;
  }
}

// POST — receive a parsed inbound email from a provider webhook or the backfill
// script. (The server's own mailbox is drained by the IMAP bridge in
// `src/services/inboundMailBridge.ts`, which calls the same routing logic
// directly.) Routes it to a thread only when the HMAC reply token verifies AND
// the sender is a participant of that thread — or, for a `crm+` address, logs
// it on the matching account (BCC-to-CRM, src/lib/crmBcc.ts).
export async function POST(request: Request) {
    // The mail provider can deliver a burst from one IP, so allow 120 messages per minute.
  const limited = enforceRateLimit(request, 'inbound-email', { limit: 120, windowMs: 60 * 1000 });
  if (limited) return limited;
  if (!secretOk(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = schema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });

  const result = await routeInboundMail(parsed.data);
  if (!result.ok) return NextResponse.json({ error: result.reason }, { status: result.status });
  if (result.kind === 'crm-bcc') return NextResponse.json({ ok: true, logged: result.logged, duplicates: result.duplicates });

  return NextResponse.json({ ok: true, created: !result.duplicate });
}
