// `GET /api/cron?job=<key>&enqueue=1` (#1677): which queued job a route key
// stands for, and with which narrowing. Pure — the route does the
// authorization (#1575) first and passes the org it settled on.
//
// A key that is missing here is not enqueueable (the batch, `re-engagement`,
// anything unknown): the route answers 400 rather than guessing.
import type { JobName, ScopedPayload } from './types';

export interface ManualJobPlan {
  name: JobName;
  payload: ScopedPayload & { batch?: number };
  /** The tenant the job belongs to; the worker binds it (runWithOrg). */
  orgId: string | null;
}

/** Route key → job, for the jobs that sweep every tenant (super admin only). */
const PLATFORM: Record<string, JobName> = {
  'weekly-reports': 'reports.weeklyReportReminders',
  'email-health': 'email.healthCheck',
  'stage-deadlines': 'reminders.stageDeadline',
  // One nudge on day 7, expiry on day 14 (#1775).
  'mentorship-requests': 'requests.expirySweep',
  'meeting-logs': 'meetings.autoLog',
  retention: 'reminders.retentionReconsent',
  newsletters: 'newsletter.dispatch',
  'newsletter-queue': 'newsletter.queue',
  // The sweep enqueues the check-ins and the mentor reminders on success.
  dormant: 'dormancy.sweep',
  'audit-drain': 'audit.drain',
  'dlq-alert': 'jobs.deadLetterAlert',
  'retention-prune': 'retention.prune',
  'usage-rollup': 'usage.rollup',
  'meeting-series-reminders': 'meetings.seriesReminders',
  'missing-documents': 'documents.missingReminders',
  // Narrowed to one tenant when the route was given an allowed `orgId`.
  'trial-reminders': 'trial.reminders',
};

/** Route key → job, for the jobs scoped to the caller's own org (OWN_ORG_JOBS). */
const OWN_ORG: Record<string, JobName> = {
  'relation-health': 'relationHealth.sweep',
  evaluations: 'evaluations.reminders',
  'program-journey': 'programJourney.run',
  surveys: 'surveys.campaigns',
  'report-subscriptions': 'reports.subscriptions',
};

export const ENQUEUEABLE_KEYS: readonly string[] = [...Object.keys(PLATFORM), ...Object.keys(OWN_ORG)].sort();

export function manualJobFor(
  key: string | null,
  input: { orgId: string | null; at?: string | null; batch?: string | null }
): ManualJobPlan | null {
  if (!key) return null;
  const at = input.at && !Number.isNaN(Date.parse(input.at)) ? input.at : undefined;
  if (OWN_ORG[key]) {
    // Own-org jobs always carry the caller's org — never "every tenant".
    if (!input.orgId) return null;
    const batch = Number.parseInt(input.batch ?? '', 10);
    return {
      name: OWN_ORG[key],
      payload: {
        orgIds: [input.orgId],
        ...(at ? { at } : {}),
        ...(key === 'surveys' && Number.isFinite(batch) && batch > 0 ? { batch } : {}),
      },
      orgId: input.orgId,
    };
  }
  if (PLATFORM[key]) {
    if (key === 'trial-reminders' && input.orgId) {
      return { name: PLATFORM[key], payload: { orgIds: [input.orgId] }, orgId: input.orgId };
    }
    return { name: PLATFORM[key], payload: {}, orgId: null };
  }
  return null;
}

/**
 * Job → the `/api/cron?job=` key that re-runs it, for the operations console's
 * re-run button (#1607). `platform` keys take a super admin at the route; the
 * console asks here instead of keeping its own copy of either table.
 */
export function manualKeyForJob(name: JobName): { key: string; platform: boolean } | null {
  for (const [key, job] of Object.entries(OWN_ORG)) if (job === name) return { key, platform: false };
  for (const [key, job] of Object.entries(PLATFORM)) if (job === name) return { key, platform: true };
  return null;
}
