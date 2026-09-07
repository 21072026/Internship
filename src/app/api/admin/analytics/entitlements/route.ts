import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getSetting } from '@/lib/settings';
import { withTenantScope } from '@/lib/orgContext';

// GET — which analytics tier this tenant may see (#1442).
//
// This endpoint answers a RENDERING question, not an authorization one. The
// analytics screen used to discover the premium tier by calling the gated
// cohorts endpoint and reading the 403 back, so every visit by an unentitled
// admin fired four failing requests and logged four console errors — a designed
// state that looked exactly like a fault, and noise that teaches everyone
// reading the console to ignore errors.
//
// The gates themselves do not move: analytics/cohorts, analytics/sources and
// analytics/benchmark each still re-read the setting server-side and still
// return 403 `feature_locked` to an unentitled caller. A client that lies to
// itself about this flag gets a nicer-looking page and not one extra row of
// premium data.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return withTenantScope(session, async () =>
    NextResponse.json({ premiumAnalytics: (await getSetting('premiumAnalytics')) === 'true' }),
  );
}
