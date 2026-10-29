import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { entitled } from '@/lib/entitlements';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { withTenantScope } from '@/lib/orgContext';
import { sourceConversion } from '@/lib/analyticsReports';
import { getLocale } from '@/i18n/server';
import { tenantWhere } from '@/lib/tenantFilter';

// GET — lead attribution: per referral source, how many people came in and what
// share of them reached the tenant's finished stage (Faz 2, #539; generalised to
// the marketing funnel in #2421).
//
// What counts as "finished" is the tenant's own stage set (#1882), not a literal
// `['HIRED_660','EMPLOYED_700']` — a customer that renamed its pipeline used to
// see every source convert at 0%. Who counts as an attributed person is decided
// in ONE place too (src/lib/leadAttribution.ts) rather than by a `role: 'MENTEE'`
// literal inline; read that file's header before changing either.
//
// ── TWO DECISIONS THIS ENDPOINT RECORDS (#2421) ──────────────────────────────
//
// 1. WHERE A MARKETING TENANT REACHES THIS. Not through /admin/sources: that
//    screen is nav-gated on the `sourcing` capability (src/lib/navLinks.ts) and
//    the MARKETING vertical does not carry it (src/lib/verticals.ts) — `sourcing`
//    is the partner-institution intake MODULE (the SOURCE role, its own login,
//    its own candidate submissions), which a marketing tenant genuinely does not
//    have. Attribution is not that module; it is a report. So the attribution
//    table is reached from /admin/analytics, which carries NO capability tag and
//    is therefore already visible to every vertical, and is mounted by
//    <SourceConversion /> there. No new screen, and no widening of `sourcing`
//    just to show a table — which would have handed a marketing tenant the whole
//    intake module as a side effect. Whoever gates the analytics page's
//    mentorship cards for MARKETING (#2423) must leave this card mounted.
//
// 2. THE PREMIUM GATE STAYS. A MARKETING tenant does NOT get attribution for
//    free. Which reports a tenant has paid for is a plan/entitlement question,
//    and ADVANCED_ANALYTICS is resolved per tenant (entitled() in
//    src/lib/entitlements.ts: the org's plan or a grant), so an org that buys the tier
//    gets the report whatever its vertical is. Making the answer depend on the
//    vertical instead would be a second, parallel entitlement system whose rules
//    nobody could state — and it would price a feature by which product the
//    customer bought rather than by what they paid for.
export async function GET(request: Request) {
  const gate = await requirePermission('analytics.read', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  // The CALLER's tier, org passed explicitly: this runs before the tenant
  // scope binds, so a bare call read only the global row.
  if (!(await entitled(await settingsOrgOf(session), 'ADVANCED_ANALYTICS'))) {
    return NextResponse.json({ error: 'feature_locked', code: 'feature_locked', feature: 'ADVANCED_ANALYTICS' }, { status: 403 });
  }

  const locale = await getLocale();

  return await withTenantScope(session, async () => {
    const orgId = (session.user as { orgId?: string | null }).orgId ?? null;
    // The caller's tenant, by hand (#2570) — the middleware is dormant, and
    // both halves of this report are tenant data. The computation, including
    // who counts as "unsourced", is src/lib/analyticsReports.ts's (#1905).
    const { rows, unsourced, outcome } = await sourceConversion({ stageOrgId: orgId, tenant: await tenantWhere(session), locale });

    return NextResponse.json({
      sources: rows,
      unsourced,
      // See the cohorts route: the screen names the stage it counted.
      finishedLabel: outcome.finishedLabel,
      finishedLabelIsCustom: outcome.finishedLabelIsCustom,
    });
  });
}
