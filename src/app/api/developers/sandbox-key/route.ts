import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/rateLimit';
import { SANDBOX_MINTS_PER_HOUR, sandboxEnabled } from '@/lib/api/sandboxKeyRule';
import { mintSandboxKey } from '@/lib/api/sandboxKey';

export const dynamic = 'force-dynamic';

// POST — a read-only, day-long sandbox key from the developer portal (#1992).
// No session on purpose: it exists for a visitor who has no account. It answers
// 404 everywhere but the public demo deployment (sandboxEnabled(): DEMO_MODE AND
// a `_demo` database), so it can never be minted against a real organisation;
// on the demo it is bound to the synthetic default org, rate-limited per address
// and capped deployment-wide.
export async function POST(request: Request) {
  if (!sandboxEnabled(process.env)) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const limited = enforceRateLimit(request, 'sandbox-key', { limit: SANDBOX_MINTS_PER_HOUR, windowMs: 60 * 60 * 1000 });
  if (limited) return limited;
  const minted = await mintSandboxKey();
  if (!minted.ok) return NextResponse.json({ error: 'Too many sandbox keys are live; try again later', code: 'sandbox_capacity' }, { status: 429 });
  return NextResponse.json(
    { key: minted.key, expiresAt: minted.expiresAt.toISOString(), scopes: minted.scopes },
    { status: 201, headers: { 'Cache-Control': 'no-store' } },
  );
}
