import cron from 'node-cron';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { logActivity } from '@/lib/activity';
import { getSetting, getSettings, SETTING_DEFAULTS, type SettingKey } from '@/lib/settings';
import {
  RETAINED_NOTIFICATION_TYPES,
  notificationRetentionCutoff,
} from '@/lib/notificationRetention';
import { EMAIL_LOG_RETENTION_DAYS, pruneEmailLog } from '@/services/emailService';
import { anonymizeUser } from '@/lib/accountErasure';
import {
  ORPHAN_ANONYMIZE_PER_RUN,
  ORPHAN_APPLICANT_GRACE_DAYS,
  ORPHAN_GRACE_SETTING_KEY,
  orphanApplicantWhere,
} from '@/lib/orphanApplicant';
import {
  RETENTION_ACTIVITY_ACTION,
  formatRetentionSummary,
  pruneInBatches,
  registerRetention,
  runRetention,
  type RetentionContext,
  type RetentionEntry,
  type RetentionOutcome,
  type RetentionRunResult,
} from '@/lib/retentionPrune';

// The tables THIS issue owns, expressed as entries in the one registry (#1678).
// The mechanism — the registry, the batching, the runner, the audit row — is in
// `retentionPrune.ts` and is deliberately Prisma-free; this file is where the
// policy meets the database.
//
// Notification (#1646) arrived exactly that way — one more entry, no new
// schedule. Three tables are still queued behind this file and each will arrive
// the same way: AuditLog (#1585), DomainEvent (#1691) and Message (#2056, which
// masks rather than deletes). The contract they follow is written down in
// docs/pii-access-lifecycle.md.
//
// WHERE THE WINDOWS COME FROM. Each one is a decision with a reason attached,
// not a round number: the reason is on the entry, it is repeated in the docs,
// and it is what an operator gets asked about when somebody sends a data
// request. Where the repo already publishes a period, these match it rather
// than inventing a second one — `EMAIL_LOG_RETENTION_DAYS` (90) is unchanged
// and merely moved, and PageView's window is the six months
// `POST_MENTORSHIP_ACCESS_MONTHS` already commits to in
// docs/pii-access-lifecycle.md.

/**
 * ActivityLog actions that are EVIDENCE, and are therefore never deleted by
 * age.
 *
 * The rest of ActivityLog is an operational trail: useful for weeks, occasionally
 * for an incident review, and disposable after a year. These five are not. Each
 * one is the record that a *right was exercised* or an *agreement was given*,
 * and the row is the only proof that it happened:
 *
 *   - `email.unsubscribe` / `email.resubscribe` — docs/EMAIL_DELIVERABILITY.md
 *     is explicit that "an opt-out that leaves no row cannot be proved to a
 *     recipient who says they asked twice". The current preference lives on the
 *     User row, so deleting these never re-subscribes anybody — it only destroys
 *     the answer to "when did they ask?".
 *   - `account.delete` / `account.export` — the record that an erasure or
 *     portability request was served. Deleting the record of a deletion leaves
 *     nothing to show the request was honoured.
 *   - `contributor_terms.accepted` — the IP chain (docs/legal/contributor-terms-in-app.md).
 *     The primary evidence is the ContributorTermsAcceptance row; this is the
 *     cross-check, and it costs one row per contributor.
 *
 * Keeping the row is not the same as keeping everything on it: past the same
 * cutoff these rows have their `ip` and `userAgent` stripped (see below), so
 * what survives is who/what/when, not the network identifiers.
 */
export const RETAINED_ACTIVITY_ACTIONS = [
  'email.unsubscribe',
  'email.resubscribe',
  'account.delete',
  'account.export',
  'contributor_terms.accepted',
] as const;

async function pruneActivityLog(ctx: RetentionContext) {
  // Everything that is not evidence goes, oldest first. Served by
  // @@index([createdAt]) on ActivityLog.
  const removal = await pruneInBatches({
    batchSize: ctx.batchSize,
    budget: ctx.budget,
    selectIds: async (take) =>
      (
        await prisma.activityLog.findMany({
          where: { createdAt: { lt: ctx.cutoff }, action: { notIn: [...RETAINED_ACTIVITY_ACTIONS] } },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
          take,
        })
      ).map((r) => r.id),
    handleBatch: async (ids) =>
      (await prisma.activityLog.deleteMany({ where: { id: { in: ids } } })).count,
  });

  // The evidence rows stay, but the two columns that make them personal data
  // rather than a fact about the account do not. This is the same shape #2056
  // needs — an entry that rewrites rows instead of removing them — and it is
  // here because the alternative was keeping IP addresses forever on the one
  // set of rows we had just decided we may never delete.
  const scrub = await pruneInBatches({
    batchSize: ctx.batchSize,
    budget: Math.max(0, ctx.budget - removal.processed),
    selectIds: async (take) =>
      (
        await prisma.activityLog.findMany({
          where: {
            createdAt: { lt: ctx.cutoff },
            action: { in: [...RETAINED_ACTIVITY_ACTIONS] },
            OR: [{ ip: { not: null } }, { userAgent: { not: null } }],
          },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
          take,
        })
      ).map((r) => r.id),
    handleBatch: async (ids) =>
      (await prisma.activityLog.updateMany({ where: { id: { in: ids } }, data: { ip: null, userAgent: null } }))
        .count,
  });

  return {
    deleted: removal.processed,
    masked: scrub.processed,
    capped: removal.capped || scrub.capped,
  };
}

async function prunePageViews(ctx: RetentionContext) {
  const { processed, capped } = await pruneInBatches({
    batchSize: ctx.batchSize,
    budget: ctx.budget,
    selectIds: async (take) =>
      (
        await prisma.pageView.findMany({
          where: { createdAt: { lt: ctx.cutoff } },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
          take,
        })
      ).map((r) => r.id),
    handleBatch: async (ids) => (await prisma.pageView.deleteMany({ where: { id: { in: ids } } })).count,
  });
  return { deleted: processed, capped };
}

async function pruneStalePushSubscriptions(ctx: RetentionContext) {
  // A push subscription is NOT pruned on age alone, and the reason matters.
  //
  // The provider's own rejection is already handled and is the primary
  // mechanism: `src/lib/webPush.ts` deletes a row the moment the push service
  // answers 404/410, and after five consecutive non-definitive failures. So a
  // dead endpoint that we ever try to use is gone without this entry — an age
  // rule that pretended otherwise would be hiding that path, not backing it up.
  //
  // What is left is the row nobody ever pushes to: `lastSeenAt` only moves on a
  // successful delivery or on a re-subscribe, and re-subscribe today happens
  // only when the user visits Account settings (nothing re-registers at app
  // boot — noted as an adjacent gap on #1678). A user who simply receives no
  // notifications for six months therefore looks identical to a dead browser.
  // Deleting theirs would silently switch their notifications off with no way
  // for the app to notice, so the rule adds the second condition that tells the
  // two apart: the ACCOUNT must have gone quiet too. A subscription is stale
  // when neither the endpoint nor its owner has been seen inside the window.
  const ownerQuiet = {
    AND: [
      { OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: ctx.cutoff } }] },
      { OR: [{ lastLoginAt: null }, { lastLoginAt: { lt: ctx.cutoff } }] },
    ],
  };

  const { processed, capped } = await pruneInBatches({
    batchSize: ctx.batchSize,
    budget: ctx.budget,
    selectIds: async (take) =>
      (
        await prisma.pushSubscription.findMany({
          where: { lastSeenAt: { lt: ctx.cutoff }, user: ownerQuiet },
          orderBy: { lastSeenAt: 'asc' },
          select: { id: true },
          take,
        })
      ).map((r) => r.id),
    handleBatch: async (ids) =>
      (await prisma.pushSubscription.deleteMany({ where: { id: { in: ids } } })).count,
  });
  return { deleted: processed, capped };
}

/**
 * Terminal job rows that nobody will ever read again.
 *
 * DEAD_LETTER is never pruned — those are precisely the rows an operator still
 * needs, and they are what the daily alert (src/lib/jobs/dlqAlert.ts) reports
 * on. FAILED is not pruned either: a FAILED row is mid-retry and on its way to
 * SUCCEEDED or DEAD_LETTER, and one that is stuck there is a diagnosis, not
 * clutter. That leaves SUCCEEDED and CANCELLED, dated by `updatedAt` — the
 * moment the job reached its terminal state, not the moment it was enqueued.
 */
const PRUNABLE_JOB_STATUSES = ['SUCCEEDED', 'CANCELLED'] as const;

async function pruneFinishedJobs(ctx: RetentionContext) {
  const { processed, capped } = await pruneInBatches({
    batchSize: ctx.batchSize,
    budget: ctx.budget,
    selectIds: async (take) =>
      (
        await prisma.job.findMany({
          where: { status: { in: [...PRUNABLE_JOB_STATUSES] }, updatedAt: { lt: ctx.cutoff } },
          orderBy: { updatedAt: 'asc' },
          select: { id: true },
          take,
        })
      ).map((r) => r.id),
    handleBatch: async (ids) => (await prisma.job.deleteMany({ where: { id: { in: ids } } })).count,
  });
  return { deleted: processed, capped };
}

/** The configured window for one org, falling back to the code default. */
async function notificationWindowFor(orgId: string | null): Promise<number> {
  const fallback = Number.parseInt(SETTING_DEFAULTS.notificationRetentionDays, 10);
  try {
    const parsed = Number.parseInt(await getSetting('notificationRetentionDays', orgId), 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/**
 * In-app notification rows (#1646).
 *
 * THE WINDOW IS RESOLVED PER ORG, INSIDE THIS FUNCTION. The runner resolves one
 * window per entry and hands it down as `ctx.cutoff`; that is right for the
 * telemetry tables, which are instance-wide, and wrong here — a notification
 * belongs to a user, a user belongs to a tenant, and each tenant sets its own
 * window. Reading the setting once at the top would apply whichever org
 * happened to be first to everybody (#1561). `ctx.cutoff` is therefore
 * deliberately unused below; `ctx.now` is not, because every cutoff in a run
 * must come off the same clock.
 *
 * Two rails, neither of which any setting can lower:
 *   1. an UNREAD row is never deleted — it is still the notification the person
 *      has not seen, and an over-eager window must not be able to empty a bell
 *      somebody is about to open;
 *   2. nothing younger than NOTIFICATION_RETENTION_FLOOR_DAYS is deleted.
 * A third, narrower one is RETAINED_NOTIFICATION_TYPES. All three are stated,
 * with their reasoning, in `src/lib/notificationRetention.ts`.
 */
export async function pruneNotifications(ctx: RetentionContext): Promise<RetentionOutcome> {
  // Users with no org (a single-tenant installation, and anybody not bound to
  // one) resolve against the global settings layer — that is the `null` scope,
  // and it is a scope like any other from here on.
  const orgs = await prisma.organization.findMany({ select: { id: true }, orderBy: { id: 'asc' } });
  const scopes: (string | null)[] = [...orgs.map((o) => o.id), null];

  // ONE SELECT PER DISTINCT WINDOW, NOT ONE PER TENANT. Resolving the setting is
  // per scope and must stay that way (#1561); the QUERY does not have to be.
  // Every scope that lands on the same cutoff is swept together, so an instance
  // where nobody overrode the default — the normal case, however many orgs it
  // has — walks the index once a night instead of once per org. What the loop
  // costs is not hypothetical: the rows this sweep may never delete (unread
  // ones, the retained types, anything belonging to a keep-forever tenant) stay
  // inside the scanned range for good, so every extra pass re-walks a prefix
  // that only grows.
  const groups = new Map<number, { cutoff: Date; orgIds: string[]; includeNull: boolean }>();
  let keepForever = 0;

  for (const orgId of scopes) {
    const cutoff = notificationRetentionCutoff(ctx.now, await notificationWindowFor(orgId));
    if (!cutoff) {
      keepForever += 1;
      continue;
    }
    const group = groups.get(cutoff.getTime()) ?? { cutoff, orgIds: [], includeNull: false };
    if (orgId === null) group.includeNull = true;
    else group.orgIds.push(orgId);
    groups.set(cutoff.getTime(), group);
  }

  let deleted = 0;
  let capped = false;

  for (const group of groups.values()) {
    const budget = ctx.budget - deleted;
    if (budget <= 0) {
      capped = true;
      break;
    }

    // Notification has no orgId of its own; it is tenant data through its
    // owner, which is where the scope comes from. `orgId: { in: [] }` matches
    // nothing and `in` never matches NULL, so the two halves are separate
    // branches rather than one clause.
    const owners: Prisma.NotificationWhereInput[] = [];
    if (group.orgIds.length > 0) owners.push({ user: { orgId: { in: group.orgIds } } });
    if (group.includeNull) owners.push({ user: { orgId: null } });

    const where: Prisma.NotificationWhereInput = {
      createdAt: { lt: group.cutoff },
      // Rail 1. Never an unread row, at any age.
      read: true,
      type: { notIn: [...RETAINED_NOTIFICATION_TYPES] },
      OR: owners,
    };

    const outcome = await pruneInBatches({
      batchSize: ctx.batchSize,
      budget,
      selectIds: async (take) =>
        (
          await prisma.notification.findMany({
            where,
            orderBy: { createdAt: 'asc' },
            select: { id: true },
            take,
          })
        ).map((r) => r.id),
      handleBatch: async (ids) =>
        (await prisma.notification.deleteMany({ where: { id: { in: ids } } })).count,
    });

    deleted += outcome.processed;
    capped = capped || outcome.capped;
  }

  return {
    deleted,
    capped,
    // Terse on purpose: `formatRetentionSummary` puts this in the nightly
    // `retention.pruned` row, which shares ActivityLog.detail's 191 characters
    // with every other entry's counts. It is the only thing that tells an
    // operator "this window is switched off here" apart from "it ran and found
    // nothing" — both of which are otherwise `notification=0`, i.e. nothing.
    note: keepForever > 0 ? `off:${keepForever}/${scopes.length}` : undefined,
  };
}

/**
 * Anonymize orphan applicant accounts past the grace period (#1780).
 *
 * The only entry in the registry that touches a person's account rather than a
 * telemetry table, so three things are different about it:
 *
 * 1. It ANONYMIZES, it never deletes. The declined `MentorshipRequest` and the
 *    user row stay, so the funnel counts of a closed cycle do not move under an
 *    admin who re-runs last quarter's report; what goes is the personal data on
 *    and around the row.
 * 2. It goes through `anonymizeUser` (src/lib/accountErasure.ts) — the same
 *    function the admin erase button calls. There is deliberately no second
 *    deletion path in this product, and this job does not become one.
 * 3. Its selection rule is not "old rows in a table" but
 *    `orphanApplicantWhere()`, which lives in ONE module and is what the admin
 *    dry run at /admin/retention lists. What the sweep takes tonight is exactly
 *    what that page showed as due — that is the whole safety story, and it is
 *    why the two read the same function instead of two similar filters.
 *
 * Idempotent by construction: anonymizing rewrites the address into the
 * `@erased.local` namespace, which the rule excludes, so a row cannot be picked
 * up twice. A failure on one account is logged and the loop moves on rather
 * than stalling the run behind it.
 */
async function anonymizeOrphanApplicants(ctx: RetentionContext) {
  let failures = 0;
  const { processed, capped } = await pruneInBatches({
    batchSize: Math.min(ctx.batchSize, 25),
    budget: Math.min(ctx.budget, ORPHAN_ANONYMIZE_PER_RUN),
    selectIds: async (take) =>
      (
        await prisma.user.findMany({
          where: orphanApplicantWhere(ctx.cutoff),
          orderBy: { createdAt: 'asc' },
          select: { id: true },
          take,
        })
      ).map((r) => r.id),
    handleBatch: async (ids) => {
      let done = 0;
      for (const id of ids) {
        try {
          await anonymizeUser(id);
          done += 1;
        } catch (e) {
          // One account that cannot be anonymized (an FK the erasure path does
          // not detach) must not stop the other 199. It stays in the list and
          // is retried tomorrow; a run where every account fails returns 0 and
          // the batch loop ends on its own rather than spinning.
          failures += 1;
          logger.error('Orphan applicant anonymization failed', { userId: id, error: String(e) });
        }
      }
      return done;
    },
  });

  // Its own audit row on top of the shared `retention.pruned` line: this is the
  // only scheduled job in the product that erases a person's data, and "which
  // night did that account go?" has to be answerable on its own.
  if (processed > 0 || failures > 0) {
    await logActivity({
      action: 'retention.orphanApplicants',
      level: failures > 0 ? 'warning' : 'info',
      targetType: 'system',
      detail: `anonymized=${processed} failed=${failures} graceDays=${ctx.retentionDays}`,
    });
  }

  // Reported as `masked`, not `deleted`: nothing was removed, and the summary
  // line an operator reads should not claim otherwise.
  return {
    deleted: 0,
    masked: processed,
    capped,
    ...(failures > 0 ? { note: `${failures} failed` } : {}),
  };
}

/**
 * The built-in policy, in one place.
 *
 * Registered at import time and keyed, so importing this module twice (the dev
 * server re-evaluating it, a test importing it after the cron bootstrap did)
 * leaves one entry per table rather than two.
 */
export const BUILT_IN_RETENTION_ENTRIES: RetentionEntry[] = [
  {
    key: 'activityLog',
    settingKey: 'activityLogRetentionDays',
    defaultDays: 365,
    reason:
      'The security ledger, and the longest window of the four: it carries ip/userAgent, so an incident review can ask "was this really the user?" — and that question is asked about things noticed months later, across a full annual audit cycle. Evidence actions (RETAINED_ACTIVITY_ACTIONS) survive it; their identifiers do not.',
    run: pruneActivityLog,
  },
  {
    key: 'pageView',
    settingKey: 'pageViewRetentionDays',
    defaultDays: 180,
    reason:
      'The shortest window, because this is the most invasive table and the least useful when old: it is per-user browsing history, and the ONLY surface that reads it — the mentee activity report — can ask for 1, 7 or 30 days and nothing else. 180 days is six times the longest readable window and matches the six-month post-mentorship access window already published in docs/pii-access-lifecycle.md.',
    run: prunePageViews,
  },
  {
    key: 'pushSubscription',
    settingKey: 'pushSubscriptionStaleDays',
    defaultDays: 180,
    reason:
      'Dead weight, in the schema comment\'s own words. The provider-rejection path in webPush.ts is the primary cleanup; this catches the endpoint nobody ever pushed to. Six months, and only when the owning account has been quiet for the same six months, so a live user who simply gets no notifications keeps theirs.',
    run: pruneStalePushSubscriptions,
  },
  {
    key: 'job',
    settingKey: 'jobRetentionDays',
    defaultDays: 30,
    reason:
      'A finished job is read for debugging within days, and the queue is the highest-churn table in the product. Thirty days covers "what ran last month?" and keeps the table small enough that the claim query stays fast. DEAD_LETTER and FAILED rows are never pruned.',
    run: pruneFinishedJobs,
  },
  {
    key: 'orphanApplicant',
    // Resolved from the GLOBAL settings row: `runRetentionPrune` calls
    // `getSettings()` with no org bound and sweeps every tenant's rows in one
    // pass, so a per-tenant override would be written and never read. The admin
    // dry run reads the same layer for the same reason (#1780).
    settingKey: ORPHAN_GRACE_SETTING_KEY,
    defaultDays: ORPHAN_APPLICANT_GRACE_DAYS,
    reason:
      'The one entry that touches a person rather than a telemetry row: a /apply account whose mentor declined can never sign in, belongs to nobody, and has no consentAt for the consent-based review to anchor on — so it would otherwise be kept forever (GDPR Art. 5(1)(e)). Ninety days leaves a full quarter for a human to notice a wrong decision, and the account is ANONYMIZED rather than deleted so closed-cycle funnel counts stay stable. The rule, and every sign of life that excludes an account from it, is in src/lib/orphanApplicant.ts; /admin/retention lists exactly what the next run would take.',
    run: anonymizeOrphanApplicants,
  },
  {
    key: 'emailLog',
    // No setting: this window is a published product decision (#1211,
    // docs/EMAIL_DELIVERABILITY.md), not an operator knob. It is unchanged at
    // 90 days and merely moved here out of the 09:00 mail tick.
    defaultDays: EMAIL_LOG_RETENTION_DAYS,
    reason:
      'The delivery log answers "did our mail go out?", a question asked within hours — but every row holds a recipient address, so keeping them forever would build a second, unmanaged store of personal data next to the one the retention rules already govern (#1211).',
    run: async (ctx) => {
      const { deleted, capped } = await pruneEmailLog(ctx.retentionDays, {
        batchSize: ctx.batchSize,
        budget: ctx.budget,
      });
      return { deleted, capped };
    },
  },
  {
    key: 'notification',
    // Declared so the summary line, and an operator reading this list, can see
    // which knob drives it. The number the runner derives from it is the GLOBAL
    // window and is reporting only — `pruneNotifications` re-resolves the
    // setting per org and ignores `ctx.cutoff`, because one window per instance
    // would hand the first tenant's choice to every other tenant (#1561).
    settingKey: 'notificationRetentionDays',
    defaultDays: Number.parseInt(SETTING_DEFAULTS.notificationRetentionDays, 10),
    reason:
      'A bell entry is a rendered sentence about a person plus a link to their record — the same category of personal data EmailLog is pruned for, and until #1646 the one table nobody ever deleted from. 180 days matches PageView, the other per-user history table, so the product defends one number rather than two. An unread row, and anything younger than 30 days, is never touched whatever the setting says; the consent and impersonation notices (RETAINED_NOTIFICATION_TYPES) are never touched at all.',
    run: pruneNotifications,
  },
];

for (const entry of BUILT_IN_RETENTION_ENTRIES) registerRetention(entry);

/**
 * Run the whole registry once and leave the audit row behind.
 *
 * The `retention.pruned` row is what makes the sweep itself accountable: it
 * says which tables lost how many rows, and its absence says the job did not
 * run. It is written whether or not anything was deleted, because "nothing to
 * prune" and "never ran" are the two answers an operator must be able to tell
 * apart — and it is what /api/health?jobs=1 reads back (src/lib/jobs/health.ts).
 *
 * The obvious loop is closed rather than special-cased: this row is an ordinary
 * ActivityLog row, subject to the ActivityLog window like any other, and it is
 * NOT in RETAINED_ACTIVITY_ACTIONS — so a year from now the sweep prunes its own
 * old receipts.
 */
export async function runRetentionPrune(options: {
  now?: Date;
  batchSize?: number;
  maxPerRun?: number;
} = {}): Promise<RetentionRunResult> {
  // One settings read for the whole run, not one per entry.
  const settings = await getSettings().catch(() => null);

  const result = await runRetention({
    ...options,
    resolveDays: (entry) => {
      if (!entry.settingKey || !settings) return null;
      const raw = settings[entry.settingKey as SettingKey];
      const parsed = Number.parseInt(raw ?? '', 10);
      return Number.isFinite(parsed) ? parsed : null;
    },
  });

  const detail = formatRetentionSummary(result);
  await logActivity({
    action: RETENTION_ACTIVITY_ACTION,
    // A failed entry is the one thing here worth waking up for; a clean run
    // stays at info and, like the dead-letter alert, says nothing louder.
    level: result.failed.length > 0 ? 'warning' : 'info',
    targetType: 'system',
    detail,
  });

  if (result.failed.length > 0) {
    logger.error('Retention prune had failing entries', {
      failed: result.failed,
      errors: result.results.filter((r) => r.error).map((r) => `${r.key}: ${r.error}`),
    });
  } else if (result.deleted > 0 || result.masked > 0) {
    logger.info('Retention prune ran', { detail });
  }

  return result;
}

const tasks = new Map<string, ReturnType<typeof cron.schedule>>();

/**
 * Register THE retention schedule in this server process. Idempotent — a
 * retried call from `/api/cron/start` is harmless.
 *
 * Registered from `/api/cron/start` rather than from `initCronJobs()`, for the
 * same reason the newsletter cron (#1469) and the dead-letter alert (#1674)
 * are: this module imports `emailService` (for the EmailLog window it took
 * over), so registering it inside `initCronJobs` would close a one-way import
 * into a cycle. It is also the honest place for it — `initCronJobs` lives in
 * the mail service, and the product's retention policy should not be owned by
 * the module that sends e-mail.
 *
 * node-cron is the carrier only until the scheduler story (#1676) lands: this
 * becomes the `retention.prune` handler registered on the queue, and the timer
 * goes away with the other twelve. `runRetentionPrune()` is the handler either
 * way.
 *
 * 03:20 UTC — deliberately in the quiet hours and clear of every other slot
 * (06:45 the dead-letter alert, 07:30 activity digests, 08:15/08:30 the Monday
 * weeklies, 09:00 the reminder batch). Deleting rows in bulk is the one
 * scheduled thing here that competes with live traffic for the same table
 * locks, so it runs when there is least of it.
 */
export function initRetentionCron() {
  if (tasks.has('retention-prune')) return;

  const task = cron.schedule('20 3 * * *', async () => {
    try {
      await runRetentionPrune();
    } catch (e) {
      // runRetentionPrune already swallows per-entry failures; reaching here
      // means the run itself could not complete (the settings read, the audit
      // row). Loud, because then there is no ActivityLog row to find later.
      logger.error('Retention prune cron failed', { error: String(e) });
    }
  });
  tasks.set('retention-prune', task);
}
