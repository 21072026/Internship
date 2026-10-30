import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { logActivity } from '@/lib/activity';
import { SETTING_DEFAULTS, type SettingKey } from '@/lib/settings';
import { resolveSettingRaw, resolveSettings } from '@/lib/settingsResolver';
import {
  RETAINED_NOTIFICATION_TYPES,
  notificationRetentionCutoff,
} from '@/lib/notificationRetention';
import { EMAIL_LOG_RETENTION_DAYS, pruneEmailLog } from '@/services/emailService';
import { anonymizeUser } from '@/lib/accountErasure';
import { OUTBOUND_DRAFT_RETENTION_DAYS, pruneOutboundDrafts } from '@/lib/outboundDrafts';
import { pruneDeliveryEvents } from '@/lib/emailSuppression';
import { DELIVERY_EVENT_RETENTION_DAYS } from '@/lib/emailSuppressionRule';
import { defaultOrgId } from '@/lib/defaultOrg';
import { messageRetentionCutoff } from '@/lib/safeguarding';
import { inquiryErasureData } from '@/lib/companyContactErasure';
import { ERASED_EMAIL_DOMAIN } from '@/lib/menteeAccount';
import { AUDIT_RETENTION_DEFAULT_DAYS, auditPrunableWhere, auditRetentionCutoff } from '@/lib/auditRetentionRule';
import {
  ORPHAN_ANONYMIZE_PER_RUN,
  ORPHAN_APPLICANT_GRACE_DAYS,
  ORPHAN_GRACE_SETTING_KEY,
  orphanApplicantWhere,
} from '@/lib/orphanApplicant';
import {
  CONTACT_PROOF_RETENTION_YEARS,
  PAYOUT_DETAILS_RETENTION_YEARS,
  retainedRecordCutoff,
} from '@/lib/erasureRetentionRule';
import { deleteExpiredContactProofs } from '@/lib/contactPermission';
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
// schedule. Two tables are still queued behind this file and each will arrive
// the same way: AuditLog (#1585) and Message (#2056, which
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

  // The native app's installs (#2775), under the same rule and the same window:
  // `lastSeenAt` moves on every app launch, so a token unseen for six months
  // whose owner has not signed in either is an app nobody opens any more. The
  // budget left over from the browsers is what this half may spend.
  const remaining = ctx.budget - processed;
  if (remaining <= 0) return { deleted: processed, capped };
  const apps = await pruneInBatches({
    batchSize: ctx.batchSize,
    budget: remaining,
    selectIds: async (take) =>
      (
        await prisma.nativePushToken.findMany({
          where: { lastSeenAt: { lt: ctx.cutoff }, user: ownerQuiet },
          orderBy: { lastSeenAt: 'asc' },
          select: { id: true },
          take,
        })
      ).map((r) => r.id),
    handleBatch: async (ids) =>
      (await prisma.nativePushToken.deleteMany({ where: { id: { in: ids } } })).count,
  });
  return { deleted: processed + apps.processed, capped: capped || apps.capped };
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

/** Default window for the domain-event record (#1691); `domainEventRetentionDays` overrides it. */
export const DOMAIN_EVENT_RETENTION_DAYS = 90;

/**
 * Domain events older than `cutoff` (#1691), oldest first, in bounded batches.
 *
 * Every tenant's rows in one pass, by the explicit `createdAt` filter alone: the
 * sweep runs with no session, so it must not depend on a bound org (with
 * MT_ENFORCE_ISOLATION on and a context bound it would see one tenant only).
 * Served by DomainEvent's @@index([createdAt]). When the outbox (#1680) adds
 * its relay columns, a row not yet relayed
 * must be excluded here — this is the one place to add that condition.
 */
export async function pruneDomainEvents(
  cutoff: Date,
  opts: { batchSize: number; budget: number },
): Promise<RetentionOutcome> {
  const { processed, capped } = await pruneInBatches({
    batchSize: opts.batchSize,
    budget: opts.budget,
    selectIds: async (take) =>
      (
        await prisma.domainEvent.findMany({
          where: { createdAt: { lt: cutoff } },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
          take,
        })
      ).map((r) => r.id),
    handleBatch: async (ids) => (await prisma.domainEvent.deleteMany({ where: { id: { in: ids } } })).count,
  });
  return { deleted: processed, capped };
}

/**
 * Settled stage-automation runs (#1703) older than the window, oldest first.
 * Every tenant's rows in one pass by `createdAt` alone, like the event record
 * the runs point at. A run still PENDING (a delayed step, at most 30 days out)
 * or RUNNING is never touched, whatever its age: its actions have not happened.
 */
export const AUTOMATION_RUN_RETENTION_DAYS = 90;

async function pruneAutomationRuns(ctx: RetentionContext): Promise<RetentionOutcome> {
  const { processed, capped } = await pruneInBatches({
    batchSize: ctx.batchSize,
    budget: ctx.budget,
    selectIds: async (take) =>
      (
        await prisma.automationRun.findMany({
          where: { createdAt: { lt: ctx.cutoff }, status: { notIn: ['PENDING', 'RUNNING'] } },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
          take,
        })
      ).map((r) => r.id),
    handleBatch: async (ids) =>
      (await prisma.automationRun.deleteMany({ where: { id: { in: ids }, status: { notIn: ['PENDING', 'RUNNING'] } } })).count,
  });
  return { deleted: processed, capped };
}

/**
 * Settled mail-queue rows (#2944). A queued mail carries no address in the
 * clear and its sealed envelope is cleared the moment it settles, but the row
 * still holds the recipient's hash and the category, and the queue is the
 * busiest corner of `Job`. So mail rows get their own, shorter windows than the
 * generic job entry: SUCCEEDED and CANCELLED after this entry's window (7 days),
 * FAILED and DEAD_LETTER after `MAIL_DEAD_RETENTION_DAYS` — long enough for the
 * daily dead-letter alert and an operator to have looked. A row still PENDING or
 * RUNNING is never touched, whatever its age: it is mail on its way.
 */
const MAIL_JOB = 'email.send';
export const MAIL_DEAD_RETENTION_DAYS = 30;

async function pruneMailOutbox(ctx: RetentionContext) {
  const deadCutoff = new Date(
    Math.min(ctx.cutoff.getTime(), ctx.now.getTime() - MAIL_DEAD_RETENTION_DAYS * 24 * 60 * 60 * 1000)
  );
  let deleted = 0;
  let capped = false;
  for (const [statuses, cutoff] of [
    [['SUCCEEDED', 'CANCELLED'], ctx.cutoff],
    [['FAILED', 'DEAD_LETTER'], deadCutoff],
  ] as const) {
    const run = await pruneInBatches({
      batchSize: ctx.batchSize,
      budget: Math.max(0, ctx.budget - deleted),
      selectIds: async (take) =>
        (
          await prisma.job.findMany({
            where: { name: MAIL_JOB, status: { in: [...statuses] }, updatedAt: { lt: cutoff } },
            orderBy: { updatedAt: 'asc' },
            select: { id: true },
            take,
          })
        ).map((r) => r.id),
      handleBatch: async (ids) => (await prisma.job.deleteMany({ where: { id: { in: ids } } })).count,
    });
    deleted += run.processed;
    capped = capped || run.capped;
  }
  return { deleted, capped };
}

/**
 * Trial reminder claim rows (#2414, story #2392).
 *
 * WHY THIS ONE IS PRUNED AT ALL, when the three claim tables it was copied from
 * are not. `WeeklyReportReminder`, `DocumentRequirementReminder` and
 * `MeetingSeriesReminder` are keyed to something that stops recurring — a week,
 * a requirement, a meeting occurrence — and they disappear with their parent
 * row through the same `onDelete: Cascade` this table has. So does this one;
 * what it adds is the case the cascade never reaches: a tenant whose funnel
 * records legitimately live for years accumulates claim rows that answer a
 * question nobody can still ask.
 *
 * WHY DELETING ONE CANNOT RESURRECT A REMINDER. The selector matches an EXACT
 * calendar-day difference (src/lib/trialReminderRule.ts), so once a trial has
 * elapsed the difference is negative and can never equal a threshold again.
 * Pruning a claim for a long-finished trial therefore un-suppresses nothing.
 * If that rule is ever loosened to "at most N days left", this entry has to go
 * in the same diff — an old claim row would then be the only thing standing
 * between an expired trial and a fresh mail about it.
 *
 * No personal data is in the row (a relation id, a number and a timestamp), so
 * this is a hygiene window rather than a data-protection one — which is exactly
 * why it is a year, longer than every window here that holds something about a
 * person (only companyUsage, hygiene for the same reason, is longer).
 */
async function pruneTrialReminders(ctx: RetentionContext) {
  const { processed, capped } = await pruneInBatches({
    batchSize: ctx.batchSize,
    budget: ctx.budget,
    selectIds: async (take) =>
      (
        await prisma.trialReminder.findMany({
          where: { sentAt: { lt: ctx.cutoff } },
          orderBy: { sentAt: 'asc' },
          select: { id: true },
          take,
        })
      ).map((r) => r.id),
    handleBatch: async (ids) =>
      (await prisma.trialReminder.deleteMany({ where: { id: { in: ids } } })).count,
  });
  return { deleted: processed, capped };
}

/**
 * Daily product-usage rows (#2446).
 *
 * The one entry whose rows come from OUTSIDE this product: one row per merchant
 * account per day, fetched from the tenant's upstream source system
 * (docs/usage-feed.md). Like the trial claim rows
 * above it carries no personal data, so this is a hygiene window rather than a
 * data-protection one — but nothing else here grows on a schedule that no user
 * of this app controls. It is in the registry for the reason PageView is — an
 * unbounded table that gains rows every night regardless of what anyone does —
 * and it arrives the way the registry contract says a new table arrives: one
 * entry, no second schedule.
 *
 * Dated by `date` (the day the usage happened), not by `createdAt`: a backfill
 * that imports two years of history writes old days today, and a `createdAt`
 * rule would keep every one of them for the full window while deleting nothing.
 */
async function pruneCompanyUsage(ctx: RetentionContext) {
  const { processed, capped } = await pruneInBatches({
    batchSize: ctx.batchSize,
    budget: ctx.budget,
    selectIds: async (take) =>
      (
        await prisma.companyUsage.findMany({
          // Served by @@index([date]) — the whole reason that index exists, and
          // the PageView lesson quoted on it.
          where: { date: { lt: ctx.cutoff } },
          orderBy: { date: 'asc' },
          select: { id: true },
          take,
        })
      ).map((r) => r.id),
    handleBatch: async (ids) =>
      (await prisma.companyUsage.deleteMany({ where: { id: { in: ids } } })).count,
  });
  return { deleted: processed, capped };
}

/**
 * Company enquiries (#2559, DSGVO Art. 5(1)(e)). Every row is one person's name,
 * address, telephone number and own words, from a web form or an import — and
 * until this entry nothing ever deleted one.
 *
 * Two rules, because the rows mean two different things once they are old:
 *   - NEVER CONVERTED (`convertedCompanyId` null): a request nobody turned into
 *     an account. Past the window it is deleted outright; nothing else points
 *     at it.
 *   - CONVERTED: the row is where the account came from, which the company's
 *     history still reads. It stays, and loses exactly the columns the account
 *     erasure scrubs (`inquiryErasureData()`, #2434) — one definition of "the
 *     personal fields of an enquiry", not a second list here.
 * Dated by `createdAt`: the window runs from the day the person wrote to us.
 * A row already tombstoned (its address on the erased domain) is not selected
 * again, so the scrub is idempotent and does not eat the per-run budget.
 */
async function pruneCompanyInquiries(ctx: RetentionContext) {
  const removal = await pruneInBatches({
    batchSize: ctx.batchSize,
    budget: ctx.budget,
    selectIds: async (take) =>
      (
        await prisma.companyInquiry.findMany({
          where: { createdAt: { lt: ctx.cutoff }, convertedCompanyId: null },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
          take,
        })
      ).map((r) => r.id),
    handleBatch: async (ids) =>
      (await prisma.companyInquiry.deleteMany({ where: { id: { in: ids } } })).count,
  });
  const scrub = await pruneInBatches({
    batchSize: ctx.batchSize,
    budget: Math.max(0, ctx.budget - removal.processed),
    selectIds: async (take) =>
      (
        await prisma.companyInquiry.findMany({
          where: {
            createdAt: { lt: ctx.cutoff },
            convertedCompanyId: { not: null },
            NOT: { email: { endsWith: `@${ERASED_EMAIL_DOMAIN}` } },
          },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
          take,
        })
      ).map((r) => r.id),
    // One statement per row: each tombstone address carries the row's own id,
    // so the scrubbed rows stay distinguishable (and this can never collide
    // with an erased account's `erased-<userId>@…`).
    handleBatch: async (ids) => {
      let count = 0;
      for (const id of ids) {
        const res = await prisma.companyInquiry.updateMany({
          where: { id, NOT: { email: { endsWith: `@${ERASED_EMAIL_DOMAIN}` } } },
          data: inquiryErasureData(`inquiry-${id}`),
        });
        count += res.count;
      }
      return count;
    },
  });
  return { deleted: removal.processed, masked: scrub.processed, capped: removal.capped || scrub.capped };
}

/** The configured window for one org, falling back to the code default. */
async function notificationWindowFor(orgId: string | null): Promise<number> {
  const fallback = Number.parseInt(SETTING_DEFAULTS.notificationRetentionDays, 10);
  try {
    const parsed = Number.parseInt(await resolveSettingRaw('notificationRetentionDays', { orgId }), 10);
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

/** One org's message window, falling back to keep-forever on any read error. */
async function messageWindowFor(orgId: string): Promise<number> {
  try {
    const parsed = Number.parseInt(await resolveSettingRaw('messageRetentionDays', { orgId }), 10);
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    return 0;
  }
}

/** Sender ids per IN clause — far under any placeholder limit, and a short statement. */
const MESSAGE_SENDER_CHUNK = 1000;

/**
 * Message bodies past their org's window (#2056) — MASKED, never deleted.
 *
 * The masking is the existing delete-for-everyone mechanism, applied by age:
 * attachments dropped, `body` emptied, `deletedForEveryoneAt` stamped. The row
 * stays, so the other participant's thread keeps its shape ("message deleted"
 * where the text was) instead of losing turns, and every count that reads
 * messages (the last-contact rule, unread state) keeps working. An already
 * masked row is never selected again, so the sweep is idempotent and cannot
 * re-stamp the moment a sender deleted their own message.
 *
 * THE WINDOW IS PER ORG, resolved inside this function — `ctx.cutoff` is unused
 * for the reason the notification entry gives (#1561). Default `0` = keep
 * forever, so on an installation where no programme chose a window this entry
 * touches nothing; a positive window is raised to MESSAGE_RETENTION_FLOOR_DAYS.
 *
 * WHOSE ORG. Message has no orgId and its parents do not settle it (a project or
 * group conversation has none), and `senderId` has no foreign key to User — so
 * the org is the SENDER's, resolved the way every settings read resolves a row
 * (an org-less account belongs to the default org). The same rule decides
 * which watch list a message is scanned against, so one programme's choices
 * apply to the words its own people wrote.
 */
async function maskOldMessages(ctx: RetentionContext): Promise<RetentionOutcome> {
  const fallbackOrg = await defaultOrgId();
  const orgs = await prisma.organization.findMany({ select: { id: true }, orderBy: { id: 'asc' } });
  let masked = 0;
  let capped = false;
  let keepForever = 0;

  for (const org of orgs) {
    const cutoff = messageRetentionCutoff(ctx.now, await messageWindowFor(org.id));
    if (!cutoff) {
      keepForever += 1;
      continue;
    }
    const members = await prisma.user.findMany({
      where: org.id === fallbackOrg ? { OR: [{ orgId: org.id }, { orgId: null }] } : { orgId: org.id },
      select: { id: true },
    });
    const senderIds = members.map((m) => m.id);
    for (let i = 0; i < senderIds.length; i += MESSAGE_SENDER_CHUNK) {
      const budget = ctx.budget - masked;
      if (budget <= 0) {
        capped = true;
        break;
      }
      const chunk = senderIds.slice(i, i + MESSAGE_SENDER_CHUNK);
      const outcome = await pruneInBatches({
        batchSize: ctx.batchSize,
        budget,
        selectIds: async (take) =>
          (
            await prisma.message.findMany({
              where: { senderId: { in: chunk }, createdAt: { lt: cutoff }, deletedForEveryoneAt: null },
              orderBy: { createdAt: 'asc' },
              select: { id: true },
              take,
            })
          ).map((r) => r.id),
        handleBatch: async (ids) => {
          const stamp = new Date();
          // Attachments first: once the body is masked nothing points back at
          // the bytes worth keeping, and they are reached only through the row.
          const [, res] = await prisma.$transaction([
            prisma.messageAttachment.deleteMany({ where: { messageId: { in: ids } } }),
            prisma.message.updateMany({
              where: { id: { in: ids }, deletedForEveryoneAt: null },
              data: { body: '', deletedForEveryoneAt: stamp },
            }),
          ]);
          return res.count;
        },
      });
      masked += outcome.processed;
      capped = capped || outcome.capped;
    }
    if (capped) break;
  }

  return {
    deleted: 0,
    masked,
    capped,
    // Keep-forever is the default, so "off" is the normal case — reported only
    // when SOME org has a window, where it tells a partial sweep from a full one.
    note: keepForever > 0 && keepForever < orgs.length ? `off:${keepForever}/${orgs.length}` : undefined,
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

async function pruneSupportReports(ctx: RetentionContext) {
  // The whole report goes: its screenshot, attachments and replay are
  // SupportReportFile rows that cascade with it (they live in the database —
  // there is no object store to sweep separately). Every tenant in one pass,
  // served by @@index([orgId, status, createdAt]) only loosely, which is fine
  // for a table that grows by human reports, not by traffic.
  const { processed, capped } = await pruneInBatches({
    batchSize: ctx.batchSize,
    budget: ctx.budget,
    selectIds: async (take) =>
      (
        await prisma.supportReport.findMany({
          where: { createdAt: { lt: ctx.cutoff } },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
          take,
        })
      ).map((r) => r.id),
    handleBatch: async (ids) => (await prisma.supportReport.deleteMany({ where: { id: { in: ids } } })).count,
  });
  return { deleted: processed, capped };
}

/**
 * The AuditLog window (#1585) — the ONLY code path that deletes an audit row.
 *
 * Two limits, both in src/lib/auditRetentionRule.ts: the window is raised to a
 * one-year floor whatever the setting says, and in an org with an audit drain
 * (#2012) a row the drain has not shipped yet is never touched, however old —
 * an outage of the tenant's SIEM must produce a backlog, not a silent gap. The
 * drain positions are read once per run; a drain that advances meanwhile only
 * means this run took less than it could have.
 *
 * The count lands in the run's one `retention.pruned` ActivityLog row
 * (runRetentionPrune), so the sweep of an audit trail is itself on the record.
 */
export async function pruneAuditLog(ctx: RetentionContext): Promise<RetentionOutcome> {
  const cutoff = auditRetentionCutoff(ctx.now, ctx.retentionDays);
  const drains = await prisma.auditDrain.findMany({ select: { orgId: true, cursorAt: true, cursorId: true } });
  const where = auditPrunableWhere(cutoff, drains);
  const { processed, capped } = await pruneInBatches({
    batchSize: ctx.batchSize,
    budget: ctx.budget,
    selectIds: async (take) =>
      (
        await prisma.auditLog.findMany({ where, orderBy: { createdAt: 'asc' }, select: { id: true }, take })
      ).map((r) => r.id),
    // The window is re-stated in the DELETE: an id selected a moment ago is
    // still out of window, but the guard costs nothing and makes this
    // statement unable to remove a row younger than the cutoff on its own.
    handleBatch: async (ids) =>
      (await prisma.auditLog.deleteMany({ where: { id: { in: ids }, createdAt: { lt: cutoff } } })).count,
  });
  return { deleted: processed, capped };
}

/**
 * The UWG § 7 proof of an ERASED person (#2098): kept after the erasure as
 * evidence only, deleted three years after the end of the erasure's calendar
 * year (src/lib/erasureRetentionRule.ts says why that anchor). `ctx.cutoff` is
 * ignored — the window is a year count with a year-end start, which a day
 * count cannot express.
 *
 * The ROW goes, not just `reason`: a basis with its evidence stripped is a
 * permission claim without proof, and `marketingEmailPermissionFilter()` reads
 * the basis without the address. No row reads as "no permission" everywhere.
 * The delete itself is in src/lib/contactPermission.ts, the table's one writer.
 */
async function pruneErasedContactProofs(ctx: RetentionContext): Promise<RetentionOutcome> {
  const cutoff = retainedRecordCutoff(ctx.now, CONTACT_PROOF_RETENTION_YEARS);
  const { processed, capped } = await pruneInBatches({
    batchSize: ctx.batchSize,
    budget: ctx.budget,
    selectIds: async (take) =>
      (
        await prisma.contactPermission.findMany({
          where: { subjectErasedAt: { lt: cutoff } },
          orderBy: { subjectErasedAt: 'asc' },
          select: { id: true },
          take,
        })
      ).map((r) => r.id),
    // Through the table's one writer, which re-states the window.
    handleBatch: (ids) => deleteExpiredContactProofs(ids, cutoff),
  });
  return { deleted: processed, capped };
}

/**
 * An erased affiliate partner's IBAN and account holder (#2098): kept for the
 * bookkeeping duty, cleared ten years after the end of the calendar year of the
 * LAST of the account erasure, the termination taking effect and the last
 * payout (`payoutDetailsAnchor()`, here as SQL: every one of the three before
 * the cutoff). The partner row and its payouts stay — they are the bookings;
 * only the bank details go, so the entry reports `masked`.
 */
async function clearErasedPayoutDetails(ctx: RetentionContext): Promise<RetentionOutcome> {
  const cutoff = retainedRecordCutoff(ctx.now, PAYOUT_DETAILS_RETENTION_YEARS);
  const where: Prisma.AffiliatePartnerWhereInput = {
    payoutDetailsCipher: { not: null },
    accountErasedAt: { lt: cutoff },
    OR: [{ noticeEffectiveAt: null }, { noticeEffectiveAt: { lt: cutoff } }],
    payouts: { none: { paidAt: { gte: cutoff } } },
  };
  const { processed, capped } = await pruneInBatches({
    batchSize: ctx.batchSize,
    budget: ctx.budget,
    selectIds: async (take) =>
      (
        await prisma.affiliatePartner.findMany({ where, orderBy: { accountErasedAt: 'asc' }, select: { id: true }, take })
      ).map((r) => r.id),
    handleBatch: async (ids) =>
      (
        await prisma.affiliatePartner.updateMany({
          where: { AND: [where, { id: { in: ids } }] },
          data: { payoutDetailsCipher: null },
        })
      ).count,
  });
  return { deleted: 0, masked: processed, capped };
}

async function pruneRosterRowResults(ctx: RetentionContext) {
  // Row-level detail only: the RosterRun summary it hangs off is kept, so
  // "did the sync run that night and what did it change in total?" stays
  // answerable after "which rows?" no longer is. Served by
  // @@index([createdAt]) on RosterRowResult (the sweep spans every tenant).
  const { processed, capped } = await pruneInBatches({
    batchSize: ctx.batchSize,
    budget: ctx.budget,
    selectIds: async (take) =>
      (
        await prisma.rosterRowResult.findMany({
          where: { createdAt: { lt: ctx.cutoff } },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
          take,
        })
      ).map((r) => r.id),
    handleBatch: async (ids) => (await prisma.rosterRowResult.deleteMany({ where: { id: { in: ids } } })).count,
  });
  // A run's `absentKeys` is per-person too (the keys the feed did not mention),
  // so it gets the same window; the run's counts, hash and status stay. Masked,
  // not deleted, so it is reported as such.
  const masked = await pruneInBatches({
    batchSize: ctx.batchSize,
    budget: Math.max(0, ctx.budget - processed),
    selectIds: async (take) =>
      (
        await prisma.rosterRun.findMany({
          where: { startedAt: { lt: ctx.cutoff }, NOT: { absentKeys: { equals: Prisma.DbNull } } },
          orderBy: { startedAt: 'asc' },
          select: { id: true },
          take,
        })
      ).map((r) => r.id),
    handleBatch: async (ids) =>
      (await prisma.rosterRun.updateMany({ where: { id: { in: ids } }, data: { absentKeys: Prisma.DbNull } })).count,
  });
  return { deleted: processed, masked: masked.processed, capped: capped || masked.capped };
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
    key: 'domainEvent',
    // Resolved from the GLOBAL settings row (GLOBAL_SETTING_KEYS): the sweep has
    // no org bound and takes every tenant's events in one pass.
    settingKey: 'domainEventRetentionDays',
    defaultDays: DOMAIN_EVENT_RETENTION_DAYS,
    reason:
      'An event row is a fact that something happened plus the ids it happened to — and the oldest public payloads (application.created) carry a name and an address. Its readers look back days, not years: a webhook receiver asks for a replay within a week or two (#1695), an automation run reads the event that triggered it (#1703). Ninety days covers a full quarter of "what fired, and why?" and matches the e-mail delivery log, the other "did it go out?" ledger. The durable history of a record is the record itself and its ActivityLog/AuditLog trail, not this table.',
    run: async (ctx) => pruneDomainEvents(ctx.cutoff, { batchSize: ctx.batchSize, budget: ctx.budget }),
  },
  {
    key: 'automationRun',
    // No setting: the window follows the DomainEvent record a run points at
    // (docs/automation-rules.md), not an operator knob.
    defaultDays: AUTOMATION_RUN_RETENTION_DAYS,
    reason:
      'A run row answers "what did this rule do, and did it fail?" for the admin\u2019s run log; it holds ids, stage keys and action codes, never a name or an address. Ninety days matches the domain-event record it points at, so a run never outlives the event that caused it. Runs still waiting for their delay or in flight are never pruned.',
    run: pruneAutomationRuns,
  },
  {
    key: 'mailOutbox',
    // No setting: the windows are part of the mail queue's design (#2944,
    // docs/mail-queue.md), not an operator knob.
    defaultDays: 7,
    reason:
      'A delivered or withdrawn mail is only ever looked at while somebody asks "did it go out?", which the EmailLog row answers for 90 days anyway; the queue row adds the recipient hash and a reason code and nothing else, so a week is plenty. A FAILED or DEAD_LETTER mail row is kept 30 days, past the daily dead-letter alert; it keeps its sealed message only until the deadline of that mail (at most 72 hours) so an operator can retry it, and from then on holds the hash and the code like the rest. Rows still on their way are never touched.',
    run: pruneMailOutbox,
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
    key: 'companyUsage',
    // No setting, like emailLog: this window is a product decision about how
    // much history the signals need, not an operator preference about somebody's
    // personal data. The day it becomes one it gets a SETTING_DEFAULTS key here.
    defaultDays: 400,
    reason:
      'One row per account per day, for ever, from a feed nobody has to touch — the PageView shape, and the reason it is in the registry before anything writes to it. 400 days is a full year plus a month, so a year-on-year comparison still has both of its endpoints, and it is far past the widest reader: the sparkline asks for 90 days and the churn rule for 120 (30 trailing against the 30 before it, on accounts with at least 60 days of history). Business volume rather than personal data, so the number defends a table size instead of a promise to a data subject — which is also why it is the longest window here.',
    run: pruneCompanyUsage,
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
  {
    key: 'message',
    // Declared for the operator's list; the runner's single number is not the
    // one that fires — `maskOldMessages` resolves each org's own window and
    // ignores `ctx.cutoff` (#1561). The default is keep-forever, which the
    // registry cannot express as a number, hence the nominal ten years here.
    settingKey: 'messageRetentionDays',
    defaultDays: 3650,
    reason:
      'A private conversation between a mentor and a (possibly under-age) participant is free-text personal data that nothing else in the product limits (GDPR Art. 5(1)(e)). How long a programme keeps it is that programme\'s own decision, so the window is per org and off by default; when set, bodies are MASKED with the existing delete-for-everyone mechanism rather than deleted, so the other participant\'s thread stays coherent. A window under 30 days is raised to 30. See docs/safeguarding.md.',
    run: maskOldMessages,
  },
  {
    key: 'companyInquiry',
    // Resolved from the GLOBAL settings row, like orphanApplicant: the sweep has
    // no org bound and takes every tenant's rows in one pass.
    settingKey: 'companyInquiryRetentionDays',
    defaultDays: Number.parseInt(SETTING_DEFAULTS.companyInquiryRetentionDays, 10),
    reason:
      'Every enquiry is one person\'s name, address, phone number and own words, and nothing ever deleted one (GDPR Art. 5(1)(e), #2559). Two years is long enough for a lead that went quiet to come back and for a year-on-year look at where requests came from, and short enough that a request nobody answered is not kept for ever. An enquiry never converted into an account is deleted; a converted one stays, because it is where the account came from, and loses only its personal columns — the same ones the account erasure scrubs (src/lib/companyContactErasure.ts).',
    run: pruneCompanyInquiries,
  },
  {
    key: 'outboundDraft',
    // No setting: part of the outbox's design (#2960, docs/outbound-approval.md).
    defaultDays: OUTBOUND_DRAFT_RETENTION_DAYS,
    reason:
      'A held mail that was decided — sent, scheduled, discarded or expired — keeps only its sealed one-line summary (subject, the recipient\'s name, a masked address) so the outbox can answer "what happened to that mail?" for a month; the mail itself is deleted the moment it is decided. Thirty days matches the dead-mail window of the mail queue next door. A draft still waiting is never touched: it expires on its own deadline first.',
    run: async (ctx) => pruneOutboundDrafts(ctx.cutoff, { batchSize: ctx.batchSize, budget: ctx.budget }),
  },
  {
    key: 'emailDeliveryEvent',
    // No setting: part of the suppression loop's design (#1692,
    // docs/EMAIL_DELIVERABILITY.md § Bounces and complaints).
    defaultDays: DELIVERY_EVENT_RETENTION_DAYS,
    reason:
      'A provider bounce/complaint event is kept for two questions only: "have we seen this event already?" (providers retry for hours, a day at most) and "how many soft bounces inside the seven-day window?". Thirty days answers both with room to spare. Each row holds an address, so it is not kept beyond that; the suppression it produced lives on in EmailSuppression, which is the record.',
    run: async (ctx) => pruneDeliveryEvents(ctx.cutoff, { batchSize: ctx.batchSize, budget: ctx.budget }),
  },
  {
    key: 'trialReminder',
    // No setting: nothing an operator would ever want to tune, and a knob for
    // a table with no personal data in it is a knob nobody reads.
    defaultDays: 365,
    reason:
      'A claim row says "this threshold was already handled for this trial", and that question is only asked while the trial is still counting down — a year later the trial resolved long ago and the row is a suppression ledger nobody reads. Safe to delete because the selector matches an EXACT calendar-day difference, so an elapsed trial can never match a threshold again (src/lib/trialReminderRule.ts); the row carries no personal data, which is why it gets a year rather than one of the short windows above (only companyUsage, a hygiene window for the same reason, is longer).',
    run: pruneTrialReminders,
  },
  {
    key: 'supportReport',
    // Resolved from the GLOBAL settings row: the sweep has no org bound.
    settingKey: 'supportReportRetentionDays',
    defaultDays: 90,
    reason:
      'A bug report carries a picture of someone\'s screen, their own words and, with replay, a recording of what they did — the most personal row a support tool keeps, and useful only while the problem is being worked on. Ninety days covers a fix shipping through a release train with room to spare; a report that matters beyond that has its GitHub issue, which by design carries none of it.',
    run: pruneSupportReports,
  },
  {
    key: 'rosterRowResult',
    // No setting: part of the roster feed's design (#1964, docs/roster-feed.md).
    defaultDays: 90,
    reason:
      'One row per person per roster-feed run, every night, so the table grows by the size of each tenant\'s roster daily, and every row names a person (their key, usually an e-mail address). Ninety days covers "why was this person changed last month?" with room to spare; the RosterRun summary row (counts, file hash, status) is never pruned, so the history of runs survives the detail — only its per-person `absentKeys` list is cleared on the same window.',
    run: pruneRosterRowResults,
  },
  {
    key: 'chatDelivery',
    // No setting: part of the chat apps' design (#1958, docs/chat-apps.md).
    defaultDays: 90,
    reason:
      'One row per chat delivery attempt — an event key, a DM id and a status, never the card body — kept to answer "I never got the message" and to show a failing workspace. Ninety days matches the e-mail delivery log, the other "did it go out?" ledger; a row whose workspace was uninstalled keeps only that metadata until then.',
    run: async (ctx) => {
      const { processed, capped } = await pruneInBatches({
        batchSize: ctx.batchSize,
        budget: ctx.budget,
        selectIds: async (take) =>
          (
            await prisma.chatDelivery.findMany({ where: { createdAt: { lt: ctx.cutoff } }, orderBy: { createdAt: 'asc' }, select: { id: true }, take })
          ).map((r) => r.id),
        handleBatch: async (ids) => (await prisma.chatDelivery.deleteMany({ where: { id: { in: ids } } })).count,
      });
      return { deleted: processed, capped };
    },
  },
  {
    key: 'auditLog',
    // Resolved from the GLOBAL settings row, like activityLog: the sweep has no
    // org bound and takes every tenant's rows in one pass.
    settingKey: 'auditLogRetentionDays',
    defaultDays: AUDIT_RETENTION_DEFAULT_DAYS,
    reason:
      'The privileged-action trail (impersonation, admin password resets, merges, offer and interview decisions) is evidence, and evidence is asked about across audit cycles: two years covers two annual reviews, and no setting may take it under one. A row a tenant\'s audit drain has not shipped yet is never pruned, so a SIEM outage leaves a backlog rather than a gap; nothing else in the product deletes an audit row.',
    run: pruneAuditLog,
  },
  {
    key: 'contactPermissionProof',
    // No setting: a legal decision of the rights holder (#2098), not an
    // operator knob. The runner's day count is nominal; the entry computes its
    // own year-end cutoff (src/lib/erasureRetentionRule.ts).
    defaultDays: CONTACT_PROOF_RETENTION_YEARS * 365,
    reason:
      'The UWG § 7 proof of a person who has been erased is kept only to answer a claim that a mail went out without permission — three years, the regular limitation period of that claim (§ 195 BGB), counted from the end of the calendar year of the erasure, after which no mail can reach them. Then the whole row goes: a basis without its proof would still read as a permission.',
    run: pruneErasedContactProofs,
  },
  {
    key: 'affiliatePayoutDetails',
    // No setting, for the same reason as contactPermissionProof.
    defaultDays: PAYOUT_DETAILS_RETENTION_YEARS * 365,
    reason:
      'An erased affiliate partner\'s IBAN and account holder outlive the account for the bookkeeping duty only (§ 257 HGB, § 147 AO: ten years for booking records), counted from the end of the calendar year in which the relationship ended — the latest of the erasure, the termination and the last payout. Then the details are cleared; the partner row and its payouts are the bookings and stay.',
    run: clearErasedPayoutDetails,
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
  const settings = await resolveSettings().then((r) => r.raw).catch(() => null);

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


