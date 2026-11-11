// The cross-programme comparison payload (#1652), shared by
// GET /api/admin/analytics/programs and its one-release alias
// /api/admin/analytics/cohorts. Each route gates itself (role, `mentorship`
// capability, ADVANCED_ANALYTICS) — this only computes, inside the caller's
// tenant scope.

import type { Session } from 'next-auth';
import { cohortComparison, unassignedProgramRow } from '@/lib/analyticsReports';
import { tenantWhere } from '@/lib/tenantFilter';
import type { Locale } from '@/i18n/config';

export async function programComparison(session: Session, locale: Locale) {
  const stageOrgId = (session.user as { orgId?: string | null }).orgId ?? null;
  const scope = { stageOrgId, tenant: await tenantWhere(session), locale };
  const { rows, outcome } = await cohortComparison(scope);
  const unassigned = await unassignedProgramRow(scope, outcome);
  return {
    programs: rows,
    // Relations with no programme, so programmes + unassigned = the tenant total.
    unassigned,
    // The pre-#1652 key, kept for one release for any reader of the old path.
    cohorts: rows,
    finishedLabel: outcome.finishedLabel,
    finishedLabelIsCustom: outcome.finishedLabelIsCustom,
  };
}
