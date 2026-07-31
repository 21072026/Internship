import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { z } from 'zod';
import { routeInboundEmail } from '@/lib/inboundEmail';

const schema = z.object({
  to: z.string().min(1),
  from: z.string().min(1),
  text: z.string().max(20000).optional().default(''),
  messageId: z.string().max(998).optional(),
});

function secretOk(request: Request): boolean {
  const expected = process.env.INBOUND_SECRET;
  if (!expected) return true; // not configured (dev/CI) — rely on the HMAC token gate
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
// the sender is a participant of that thread.
export async function POST(request: Request) {
  if (!secretOk(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = schema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });

  const result = await routeInboundEmail(parsed.data);
  if (!result.ok) return NextResponse.json({ error: result.reason }, { status: result.status });

  return NextResponse.json({ ok: true, created: !result.duplicate });
}
