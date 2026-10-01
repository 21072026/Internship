import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { getSetting } from '@/lib/settings';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { withTenantScope } from '@/lib/orgContext';
import { outcomeStageKeys } from '@/lib/pipelineStages';
import { getLocale } from '@/i18n/server';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { requireCapability } from '@/lib/capabilityGate';

// GET — premium cohort comparison (Faz 2, #538). Side-by-side pipeline
// conversion, time-to-hire and engagement per cohort. Gated by the
// premiumAnalytics setting (off by default — basic analytics stay free; this
// flag becomes a per-tenant entitlement with Faz 3 multi-tenancy).
//
// "Finished" and "dropped" are the TENANT'S stages, resolved once through
// `outcomeStageKeys` (#1882). This route used to carry its own
// `new Set(['HIRED_660','EMPLOYED_700'])` and therefore reported a flat zero —
// hired, conversion and time-to-hire alike — for any customer that renamed its
// pipeline. For an org on the built-in catalogue the resolved sets are exactly
// the two literals that were here, so those numbers are unchanged.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const callerOrgId = (session.user as { orgId?: string | null }).orgId ?? null;
  // Programme cohorts are the internship product (the /admin/cohorts link is
  // tagged `mentorship` in navLinks.ts); hiding the card is not access control,
  // so a vertical without the module is refused here too.
  const gated = await requireCapability(callerOrgId, 'mentorship');
  if (gated) return gated;
  // The tier is the CALLER's org's — read with the org passed explicitly, since
  // this runs before the tenant scope binds.
  if ((await getSetting('premiumAnalytics', await settingsOrgOf(session))) !== 'true') {
    return NextResponse.json({ error: 'feature_locked' }, { status: 403 });
  }

  // Resolved outside the tenant scope on purpose: `getLocale()` reads the
  // caller's own cookie/User row, exactly as the other locale-aware routes do.
  const locale = await getLocale();

  return await withTenantScope(session, async () => {
    const outcome = await outcomeStageKeys(callerOrgId, locale);
    const finished = new Set(outcome.finished);
    const offPath = new Set(outcome.offPath);

    // The caller's tenant, by hand (leak audit WP3): with MT_ENFORCE_ISOLATION
    // off this listed every org's cohorts and their conversion numbers.
    const tenant = await tenantWhere(session);
    const cohorts = await prisma.cohort.findMany({
      where: withinTenant({}, tenant),
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        term: true,
        relations: {
          where: withinTenant({}, tenant),
          select: {
            pipelineStatus: true,
            startDate: true,
            _count: { select: { interactions: true } },
            statusChanges: {
              // Time-to-hire is measured to the tenant's OWN finished stage,
              // never to a key its pipeline may not contain.
              where: { toStatus: { in: outcome.finished } },
              orderBy: { createdAt: 'asc' },
              take: 1,
              select: { createdAt: true },
            },
          },
        },
      },
    });

    const rows = cohorts.map((c) => {
      const total = c.relations.length;
      const hired = c.relations.filter((r) => finished.has(r.pipelineStatus)).length;
      const dropped = c.relations.filter((r) => offPath.has(r.pipelineStatus)).length;
      const inProgress = total - hired - dropped;
      const interactions = c.relations.reduce((n, r) => n + r._count.interactions, 0);

      // Average days from relation start to the first transition INTO a
      // finished stage, over relations that actually got there (with a
      // recorded transition).
      const hireDurations = c.relations
        .map((r) => (r.statusChanges[0] ? (r.statusChanges[0].createdAt.getTime() - r.startDate.getTime()) / 86_400_000 : null))
        .filter((d): d is number => d !== null && d >= 0);
      const avgDaysToHired = hireDurations.length
        ? Math.round(hireDurations.reduce((a, b) => a + b, 0) / hireDurations.length)
        : null;

      return {
        id: c.id,
        name: c.name,
        term: c.term,
        total,
        hired,
        dropped,
        inProgress,
        conversionToHired: total ? Math.round((hired / total) * 100) : 0,
        avgDaysToHired,
        interactionsPerRelation: total ? Math.round((interactions / total) * 10) / 10 : 0,
      };
    });

    // Echoed so the table can NAME the stage it counted (#1882) instead of
    // printing a universal "Hired" over a column that means something else in
    // this tenant. `finishedLabelIsCustom` is false for a tenant that never
    // renamed the stage — the screen then keeps its own translated word and a
    // default-catalogue tenant sees byte-identical text.
    return NextResponse.json({
      cohorts: rows,
      finishedLabel: outcome.finishedLabel,
      finishedLabelIsCustom: outcome.finishedLabelIsCustom,
    });
  });
}
