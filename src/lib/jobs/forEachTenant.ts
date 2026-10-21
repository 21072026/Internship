import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { runWithOrg } from '@/lib/orgContext';
import { isIsolationEnforced } from '@/lib/orgScope';
import { passFailure, tenantPasses } from '@/lib/jobs/forEachTenantRule';

// Run a background sweep once per tenant (#1561), each pass inside
// runWithOrg(orgId) — the one tenant context a sessionless job can have. Which
// passes are made is the pure rule in forEachTenantRule.ts: per org when
// isolation is enforced, ONE unscoped pass (today's behaviour) when it is not.
//
// Three rules for the caller:
//   - Every query of the pass is made INSIDE `fn`. Prisma promises are lazy; one
//     created outside the callback fires outside the context and is silently
//     unscoped (#958). That includes the arms of a Promise.all and a
//     transaction's array form.
//   - The passes run SEQUENTIALLY. A sweep that mails is paced by the mail
//     budget, and two tenants' passes interleaving would only make the log
//     unreadable.
//   - One tenant's failure never stops the next: it is logged with the job name
//     and the org id, and reported in the summary. The runner itself never
//     throws for a pass.
//
// The organization list is read UNSCOPED (runWithOrg(null)) so a caller that is
// itself inside a tenant scope still enumerates every tenant.

export interface TenantRunSummary {
  passes: number;
  failed: { orgId: string | null; error: string }[];
}

export async function forEachTenant(
  job: string,
  fn: (orgId: string | null) => Promise<unknown>,
  opts: { perOrgWhenUnenforced?: boolean } = {},
): Promise<TenantRunSummary> {
  const enforced = isIsolationEnforced();
  const orgIds =
    enforced || opts.perOrgWhenUnenforced
      ? (await runWithOrg(null, () => prisma.organization.findMany({ select: { id: true } }))).map((o) => o.id)
      : [];
  const passes = tenantPasses({ enforced, orgIds, perOrgWhenUnenforced: opts.perOrgWhenUnenforced });
  const summary: TenantRunSummary = { passes: passes.length, failed: [] };
  for (const orgId of passes) {
    try {
      await runWithOrg(orgId, () => fn(orgId));
    } catch (e) {
      const error = passFailure(e);
      summary.failed.push({ orgId, error });
      logger.error('tenant_pass.failed', { job, orgId, error });
    }
  }
  return summary;
}
