import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { entitledFeatures } from '@/lib/entitlements';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { withTenantScope } from '@/lib/orgContext';

// GET — which analytics tiers this tenant may see (#1442, #1740).
//
// This endpoint answers a RENDERING question, not an authorization one. The
// analytics screen used to discover the premium tier by calling the gated
// cohorts endpoint and reading the 403 back, so every visit by an unentitled
// admin fired four failing requests and logged four console errors — a designed
// state that looked exactly like a fault, and noise that teaches everyone
// reading the console to ignore errors.
//
// The answer is the org's entitlements (its plan or a grant, via
// entitledFeatures()) — the same resolver every gate asks. The gates themselves
// do not move: analytics/cohorts, analytics/sources and analytics/benchmark
// each still call entitled() server-side and still return 403 `feature_locked`
// to an unentitled caller. A client that lies to itself about these flags gets
// a nicer-looking page and not one extra row of premium data.
export async function GET(request: Request) {
  const gate = await requirePermission('analytics.read', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  return withTenantScope(session, async () => {
    const features = await entitledFeatures(await settingsOrgOf(session));
    return NextResponse.json({
      advancedAnalytics: features.has('ADVANCED_ANALYTICS'),
      reportExport: features.has('REPORT_EXPORT'),
    });
  });
}
