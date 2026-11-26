import { NextResponse } from 'next/server';
import { z } from 'zod';
import { enforceRateLimit } from '@/lib/rateLimit';
import { partnerCodeAvailability, partnerOfInvitation } from '@/lib/affiliateInvite';

// POST { token, code? } — public, for the holder of a partner invitation only
// (#3961, docs/affiliate-module.md § Referral codes). The registration form
// asks it twice:
//   - without `code`: the partner's current code and whether it can still be
//     changed (`lock`: null | 'has_account' | 'in_use'), and its display name
//     (#3963) — the partner's own, for the holder of its invitation;
//   - with `code`: `available` | `current` | `taken` | `invalid` — never who
//     holds a taken code.
// The token is the credential, so it travels in the body, not the URL (which
// lands in access logs). Anything but a live AFFILIATE invitation of this host's
// world answers 404, the same for every kind of miss. Rate-limited per IP: the
// answer is an existence probe over the programme's codes.
const schema = z.object({ token: z.string().min(1).max(200), code: z.string().max(200).optional() });

export async function POST(request: Request) {
  const limited = enforceRateLimit(request, 'invite-partner-code', { limit: 60, windowMs: 10 * 60 * 1000 });
  if (limited) return limited;

  const parsed = schema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const partner = await partnerOfInvitation(parsed.data.token);
  if (!partner) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  if (parsed.data.code === undefined) return NextResponse.json({ code: partner.code, displayName: partner.displayName, lock: partner.lock });
  const status = partner.lock
    ? parsed.data.code === partner.code ? 'current' : 'invalid'
    : await partnerCodeAvailability({ orgId: partner.orgId, partnerId: partner.partnerId, code: parsed.data.code.trim() }, partner.code);
  return NextResponse.json({ status });
}
