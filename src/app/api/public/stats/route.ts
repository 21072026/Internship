import { NextResponse } from 'next/server';
import { getPublicStats } from '@/lib/publicStats';
import { enforceRateLimit } from '@/lib/rateLimit';

// Public, session-less live numbers (#1099): exactly three integers, nothing
// else — no names, no ids, no PII. Backed by a 10-minute in-process cache
// (lib/publicStats) so the landing's traffic never turns into count() storms,
// and rate-limited like every other anonymous endpoint.
export async function GET(request: Request) {
  const limited = enforceRateLimit(request, 'public-stats', { limit: 60, windowMs: 10 * 60 * 1000 });
  if (limited) return limited;
  const stats = await getPublicStats();
  return NextResponse.json(stats, {
    headers: { 'Cache-Control': 'public, max-age=0, s-maxage=300, stale-while-revalidate=60' },
  });
}
