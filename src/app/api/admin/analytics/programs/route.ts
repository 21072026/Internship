import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { entitled } from '@/lib/entitlements';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { withTenantScope } from '@/lib/orgContext';
import { programComparison } from '@/lib/programComparison';
import { getLocale } from '@/i18n/server';
import { requireCapability } from '@/lib/capabilityGate';

// GET — premium programme comparison (Faz 2, #538; generalised from cohorts in #1652). Side-by-side pipeline
// conversion, time-to-hire and engagement per programme, plus the
// "unassigned" bucket so the rows add up to the tenant total. The single-
// programme FILTER (?program= on /api/admin/analytics and /funnel) is free;
// only this comparison is gated. /api/admin/analytics/cohorts is its alias
// for one release. Gated by the
// org's ADVANCED_ANALYTICS entitlement — its plan or a grant (#1740). Off by
// default: basic analytics stay free.
//
// "Finished" and "dropped" are the TENANT'S stages, resolved once through
// `outcomeStageKeys` (#1882). This route used to carry its own
// `new Set(['HIRED_660','EMPLOYED_700'])` and therefore reported a flat zero —
// hired, conversion and time-to-hire alike — for any customer that renamed its
// pipeline. For an org on the built-in catalogue the resolved sets are exactly
// the two literals that were here, so those numbers are unchanged.
export async function GET(request: Request) {
  const gate = await requirePermission('analytics.read', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const callerOrgId = (session.user as { orgId?: string | null }).orgId ?? null;
  // Programme cohorts are the internship product (the /admin/cohorts link is
  // tagged `mentorship` in navLinks.ts); hiding the card is not access control,
  // so a vertical without the module is refused here too.
  const gated = await requireCapability(callerOrgId, 'mentorship');
  if (gated) return gated;
  // The tier is the CALLER's org's — read with the org passed explicitly, since
  // this runs before the tenant scope binds.
  if (!(await entitled(await settingsOrgOf(session), 'ADVANCED_ANALYTICS'))) {
    return NextResponse.json({ error: 'feature_locked', code: 'feature_locked', feature: 'ADVANCED_ANALYTICS' }, { status: 403 });
  }

  // Resolved outside the tenant scope on purpose: `getLocale()` reads the
  // caller's own cookie/User row, exactly as the other locale-aware routes do.
  const locale = await getLocale();

  return await withTenantScope(session, async () => NextResponse.json(await programComparison(session, locale)));
}
