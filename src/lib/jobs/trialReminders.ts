import cron from 'node-cron';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { runWithOrg } from '@/lib/orgContext';
import { notifyIfAllowed } from '@/lib/notify';
import { notificationLink, type NotificationRole } from '@/lib/notificationLink';
import { emailAllowed } from '@/lib/notificationPrefs';
import { emailGroupAllowedForCategory } from '@/lib/emailGroups';
import { resolvePipelineStages } from '@/lib/pipelineStages';
import { stageDeadlineUpdate } from '@/lib/stageSla';
import { verticalFor } from '@/lib/verticalContext';
import type { VerticalKey } from '@/lib/verticals';
import { TRIAL_ACTIVE_STAGE_KEY, TRIAL_EXPIRED_STAGE_KEY } from '@/lib/programTemplates';
import { findDueTrialReminders, type DueTrialReminderRow } from '@/lib/trialReminders';
import { sendTrialReminderEmail } from '@/services/emailService';

// The `trial-reminders` job (#2415, #2410, #2417 — story #2392).
//
// Once a day, for every tenant that has trials, this does two things in a fixed
// order:
//
//   1. WARN — the owner of every funnel record whose trial ends in exactly 7, 3
//      or 0 calendar days hears about it, once per mark;
//   2. EXPIRE — every record whose trial ran out BEFORE today moves from the
//      tenant's TRIAL_ACTIVE stage to TRIAL_EXPIRED, so a finished trial stops
//      sitting on the board as a running one (#2417).
//
// THE ORDER IS LOAD-BEARING. The 0-day reminder selects records in the
// TRIAL_ACTIVE stage; an expiry pass that ran first would move the very records
// that are due for it, and the last mail — the one that matters most — would
// never go out. Warn, then expire.
//
// WHAT IS *NOT* HERE. Which (record, threshold) pairs are due is
// src/lib/trialReminderRule.ts (pure, unit-tested) and the queries that feed it
// are src/lib/trialReminders.ts. This module is the JOB: which tenants, which
// recipients, both channels, the per-tick budget and the counts.
//
// PER TENANT, AND EXPLICITLY SO. There is no session here, so nothing can
// resolve an org for us — src/lib/verticalContext.ts makes that a rule rather
// than a convention: a vertical is always read for an EXPLICIT orgId. The sweep
// therefore loops tenants, reads each one's vertical, and binds it with
// `runWithOrg()` for that tenant's work, exactly the way
// src/lib/rosterIngestStore.ts does for a scheduled roster feed.

/** The vertical that ships trial stages. Read per tenant, never assumed. */
const TRIAL_VERTICAL: VerticalKey = 'MARKETING';

/**
 * Reminders dispatched in ONE tick, across every tenant.
 *
 * Modelled on `DORMANT_NUDGE_MAX_PER_RUN` (src/services/emailService.ts) and
 * for the identical reason: a few hundred near-identical mails leaving in one
 * minute is the shape of traffic that gets a sending domain throttled, and the
 * domain is shared by every tenant on the box — so the ceiling is global, not
 * per org.
 *
 * WHAT "THE REST ROLLS TO THE NEXT TICK" MEANS HERE, precisely, because it is
 * not what it means for the dormant nudge. Nothing is claimed for a record this
 * tick did not reach, so the next tick reconsiders it from scratch. But the
 * selector fires on an EXACT calendar day, so a record shed today is not picked
 * up tomorrow at the same mark — it is picked up at its NEXT mark. That is why
 * the queue is drained MOST URGENT FIRST below: a shed 7-day warning is still
 * followed by the 3-day and the 0-day one, so the account is not lost in
 * silence (the point of story #2392), whereas a shed 0-day warning would be the
 * last word we never said. The alternative — a catch-up rule that re-sends a
 * missed mark late — is rejected in trialReminderRule.ts, because "ends in 7
 * days" sent on the fifth day is a mail that lies about the one fact it carries.
 */
export const TRIAL_REMINDER_MAX_PER_RUN = 50;

// ── THE BASELINE DECISION (#2410): (b) A LOWER BOUND, NOT A BACKFILL ─────────
//
// The first production tick of a new job must not mail out the whole accumulated
// history — the problem `prisma/backfill-cron-baseline.mjs` exists for, and the
// reason its header lists, job by job, which backlog each one suppresses. This
// job needs neither a backfill of claim rows nor a one-shot `Setting`, and the
// reason is structural rather than lucky:
//
//   * the selector is an EXACT calendar-day match (trialReminderRule.ts). A
//     trial that ended at any point in the past is at a NEGATIVE number of days
//     remaining, which equals no threshold, and nothing can bring it back;
//   * the candidate query already carries the lower bound that makes this true
//     at the SQL level rather than only in the rule: `findDueTrialReminders`
//     bounds `trialEndsAt` to `[now - (min(ladder) + 2)d, now + (max(ladder) +
//     2)d]`, so a trial that ran out last month is never even read.
//
// So the first tick on a populated database writes only to trials ending in
// exactly 7, 3 or 0 days — at most three days' worth of accounts, which is
// genuinely due work and not a backlog — and the per-tick cap above bounds even
// that. A backfill of `TrialReminder` rows was the alternative; it was rejected
// because it would write a permanent row per historical record to suppress mail
// that structurally cannot be sent, and those rows would then be the first thing
// a "who did we warn about an expiring trial?" report counted.
//
// The auto-expiry below is deliberately NOT baselined either: it sends nothing.
// It moves a record the board is already showing wrongly, and on the first tick
// moving every long-dead trial out of "Trial running" is the correction, not a
// backlog. The same entry in the backfill script's header says so.

export interface TrialRemindersResult {
  /** Due (record, threshold) pairs found across every tenant in scope. */
  considered: number;
  /** Pairs claimed and dispatched on at least one channel. */
  sent: number;
  /**
   * Due pairs deliberately not dispatched: over the per-tick cap, already
   * claimed by an overlapping tick, no reachable recipient, or a recipient who
   * has muted both channels.
   */
  skipped: number;
  /** Pairs whose dispatch threw, and tenants whose sweep threw. One per catch. */
  failed: number;
  /** Records moved from TRIAL_ACTIVE to TRIAL_EXPIRED by this tick (#2417). */
  expired: number;
  /** Tenants swept — vertical matched, so trials apply to them. */
  orgs: number;
}

/** The two `User` columns every gating decision reads, plus what a mail needs. */
interface Recipient {
  id: string;
  email: string;
  fullName: string;
  role: string;
  preferredLanguage: string | null;
  emailNotifications: boolean;
  notificationPrefs: unknown;
  isActive: boolean;
}

const RECIPIENT_SELECT = {
  id: true,
  email: true,
  fullName: true,
  role: true,
  preferredLanguage: true,
  emailNotifications: true,
  notificationPrefs: true,
  isActive: true,
} as const;

/**
 * Who hears about this record.
 *
 * The owner is the relation's `mentorId` — what the MARKETING overlay calls the
 * account owner (src/i18n/verticalOverlays.ts). `mentorId` is a REQUIRED FK, so
 * "unassigned" can never mean NULL here; what it means in practice is a record
 * parked on an account that is no longer in use, and the fallback for that is
 * the ADMINs OF THAT ORG — never every admin on the platform, which is what an
 * unscoped `role: 'ADMIN'` query returns on a multi-tenant box.
 */
async function recipientsFor(orgId: string, mentorId: string): Promise<Recipient[]> {
  const owner = await prisma.user.findUnique({ where: { id: mentorId }, select: RECIPIENT_SELECT });
  if (owner?.isActive) return [owner];

  return prisma.user.findMany({
    // `orgId` explicitly, not left to the tenant middleware: this runs with no
    // session, and an unscoped fallback would mail another tenant's admins
    // about a record they cannot even open.
    where: { orgId, role: 'ADMIN', isActive: true },
    select: RECIPIENT_SELECT,
  });
}

/**
 * Dispatch one due reminder on both channels, after claiming it.
 *
 * CLAIM FIRST, THEN SEND — the house convention, argued on the `TrialReminder`
 * model in prisma/schema.prisma: a mid-send failure loses a reminder rather
 * than duplicating one, and here that is affordable because the thresholds are
 * a ladder. `createMany({ skipDuplicates: true })` is what makes it atomic: two
 * overlapping ticks (or two replicas) cannot both win the same (relation,
 * threshold) pair, and the loser simply does nothing. It is also what makes the
 * second run of `/api/cron?job=trial-reminders` report zero.
 *
 * The claim records that the THRESHOLD was handled — not that a mail left. A
 * recipient who muted both channels HAS been handled: they chose the silence,
 * and the mark cannot be re-offered tomorrow anyway.
 *
 * Returns 'sent' or 'skipped'; a per-recipient send failure is caught here and
 * never fails the tick.
 */
async function dispatchReminder(row: DueTrialReminderRow): Promise<'sent' | 'skipped'> {
  const { relation, threshold } = row;
  const orgId = relation.orgId;
  if (!orgId) return 'skipped';

  const recipients = await recipientsFor(orgId, relation.mentorId);
  if (recipients.length === 0) {
    logger.warning('Trial reminder has no reachable recipient', { relationId: relation.id, threshold });
    return 'skipped';
  }

  // What the mail and the bell call this account. The company name is a proper
  // noun, interpolated verbatim in all three languages; a record with no company
  // attached yet falls back to the lead's own name rather than being dropped,
  // because the trial is just as real. If neither exists there is nothing
  // truthful to put in the subject line, so the reminder is skipped loudly
  // instead of going out with a blank in it.
  const lead = relation.companyName
    ? null
    : await prisma.user.findUnique({ where: { id: relation.menteeId }, select: { fullName: true } });
  const accountName = relation.companyName ?? lead?.fullName ?? null;
  if (!accountName) {
    logger.warning('Trial reminder has no account name', { relationId: relation.id, threshold });
    return 'skipped';
  }

  const claim = await prisma.trialReminder.createMany({
    data: [{ orgId, relationId: relation.id, threshold }],
    skipDuplicates: true,
  });
  // Another tick won it. Not an error and not a miss — exactly one of us was
  // supposed to lose.
  if (claim.count === 0) return 'skipped';

  let delivered = 0;
  for (const user of recipients) {
    const link = notificationLink(user.role as NotificationRole, 'relation', {
      relationId: relation.id,
      menteeId: relation.menteeId,
    });
    // The bell and the mail are gated SEPARATELY, on the same 'deadlines'
    // category: `notifyIfAllowed` reads the in-app switch, `emailAllowed` the
    // e-mail one, and `emailGroupAllowedForCategory` the group behind the
    // EXISTING 'stage-deadline' category. Opting out of one is not opting out of
    // the other, and neither adds a category or a preference key (#2412).
    try {
      await notifyIfAllowed(
        user.id,
        'deadlines',
        'trial.endingSoon',
        { company: accountName, days: String(threshold) },
        link,
      );
      delivered += 1;
    } catch (error) {
      logger.error('Trial reminder notification failed', { relationId: relation.id, userId: user.id, error: String(error) });
    }

    if (emailAllowed(user, 'deadlines') && emailGroupAllowedForCategory(user, 'stage-deadline')) {
      // Per-send try/catch, the house style of `checkStageDeadlineReminders`:
      // one broken address must not cost every other record its reminder.
      try {
        await sendTrialReminderEmail({
          to: user.email,
          fullName: user.fullName,
          companyName: accountName,
          trialEndsAt: relation.trialEndsAt,
          threshold,
          link,
          locale: user.preferredLanguage,
          orgId,
          userId: user.id,
        });
        delivered += 1;
      } catch (error) {
        logger.error('Trial reminder email failed', { relationId: relation.id, userId: user.id, error: String(error) });
      }
    }
  }

  return delivered > 0 ? 'sent' : 'skipped';
}

/**
 * Move every record whose trial has run out into the tenant's TRIAL_EXPIRED
 * stage (#2417).
 *
 * THE CONDITIONAL `updateMany` IS THE WHOLE POINT. `where: { id, pipelineStatus:
 * activeKey }` means a human who already moved the row — into a proposal, into a
 * loss — wins: the update matches nothing, `count` is 0, and this sweep neither
 * overwrites their decision nor audits a move that did not happen. Copied in
 * shape from `expireOffers()` (src/lib/offerNotify.ts).
 *
 * BY CALENDAR DAY, not by raw timestamp. The task says `trialEndsAt < now`; this
 * expires a trial whose last day is BEFORE today (UTC), which is one notch
 * stricter and deliberate. The whole ladder is counted in UTC calendar days
 * (trialReminderRule.ts), so a trial ending today at 00:30 is a trial that is
 * "ending today" for the 0-day mail — and with a raw `< now` comparison the same
 * tick that says "ends today" would also file it as expired. The last day is the
 * customer's; the record flips on the next day's tick.
 *
 * AUDIT: `AuditLog` with `actorId: 'system'`, NOT `StatusChange`.
 * `StatusChange.changedById` is a REQUIRED FK to `User`, so writing one here
 * means inventing a system user row — an account with an address, a role from
 * the frozen enum and a password hash, which then appears in every admin user
 * list, can be assigned work, and is counted by `countAdminSeats()` on somebody's
 * invoice. `AuditLog.actorId` is a plain String with no FK, which is exactly why
 * `expireOffers()` uses it for the same kind of unattended transition. The
 * consequence is stated rather than hidden: an automatic expiry does NOT appear
 * in the relation's own stage history, it appears in the audit log.
 *
 * DROP-OFF REASONS DO NOT APPLY, by construction. `validateDropoffReason()`
 * (src/lib/stageChange.ts) only demands a `reasonCode` for a move into an
 * OFF-PATH stage, and TRIAL_EXPIRED ships with `isOffPath: false` in the
 * marketing preset — an expired trial is a record waiting for a decision, not a
 * drop-out. Keep it that way: making it off-path would leave this sweep with a
 * rule it cannot satisfy, since an unattended job has no reason to give.
 */
export async function expireTrials(orgId: string, now: Date): Promise<number> {
  const stages = await resolvePipelineStages(orgId);
  const activeKey = stages.find((s) => s.key === TRIAL_ACTIVE_STAGE_KEY)?.key;
  const expiredKey = stages.find((s) => s.key === TRIAL_EXPIRED_STAGE_KEY)?.key;
  // A tenant that has one of the pair but not the other has nowhere to move a
  // record to; skipping is the only honest answer.
  if (!activeKey || !expiredKey) return 0;

  // Start of today in UTC — the same day boundary `utcDayNumber()` uses, built
  // from the UTC date parts so the host's timezone cannot move it.
  const startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  const due = await prisma.mentorshipRelation.findMany({
    where: { orgId, status: 'ACTIVE', pipelineStatus: activeKey, trialEndsAt: { lt: startOfToday } },
    select: { id: true },
  });
  if (due.length === 0) return 0;

  // One resolution for the whole batch: the SLA of the destination stage does
  // not vary by record.
  const deadline = await stageDeadlineUpdate(orgId, expiredKey, now);

  let expired = 0;
  for (const relation of due) {
    const claim = await prisma.mentorshipRelation.updateMany({
      where: { id: relation.id, pipelineStatus: activeKey },
      data: { pipelineStatus: expiredKey, ...(deadline ?? {}) },
    });
    if (claim.count === 0) continue;
    expired += 1;

    await prisma.auditLog
      .create({ data: { actorId: 'system', action: 'trial.expire', targetId: relation.id } })
      .catch((error) => logger.error('Trial expiry audit row failed', { relationId: relation.id, error: String(error) }));
  }

  return expired;
}

/**
 * One tick of the trial sweep.
 *
 * `now` is injectable so a spec can place a tick anywhere on the calendar;
 * `orgIds` narrows the run to named tenants, for a targeted re-run.
 */
export async function runTrialReminders(
  opts: { now?: Date; orgIds?: string[] } = {},
): Promise<TrialRemindersResult> {
  const now = opts.now ?? new Date();

  // Outside any tenant scope: the org list is what SAYS which tenants exist.
  const orgs = await runWithOrg(null, () =>
    prisma.organization.findMany({
      where: opts.orgIds ? { id: { in: opts.orgIds } } : undefined,
      select: { id: true },
    }),
  );

  const inScope: string[] = [];
  const due: DueTrialReminderRow[] = [];
  let failed = 0;

  for (const org of orgs) {
    try {
      // The gate. A tenant on another vertical has no trials, and asking per org
      // is the contract verticalContext.ts states — never inferred from a
      // session, never cached in a token.
      if ((await verticalFor(org.id)) !== TRIAL_VERTICAL) continue;
      inScope.push(org.id);
      due.push(...(await runWithOrg(org.id, () => findDueTrialReminders(org.id, { now }))));
    } catch (error) {
      failed += 1;
      logger.error('Trial reminder sweep failed for one organisation', { orgId: org.id, error: String(error) });
    }
  }

  // MOST URGENT FIRST across every tenant, then by record id so the order is
  // stable between ticks. When the cap bites it sheds the marks the ladder can
  // absorb (7 before 3 before 0), not a random slice — see the constant above.
  due.sort((a, b) => a.threshold - b.threshold || (a.relationId < b.relationId ? -1 : 1));

  let sent = 0;
  let skipped = 0;
  for (const row of due) {
    if (sent >= TRIAL_REMINDER_MAX_PER_RUN) {
      skipped += 1;
      continue;
    }
    const orgId = row.relation.orgId;
    try {
      const outcome = orgId
        ? await runWithOrg(orgId, () => dispatchReminder(row))
        : await dispatchReminder(row);
      if (outcome === 'sent') sent += 1;
      else skipped += 1;
    } catch (error) {
      // One send failing must not drop the job — #2415's acceptance criterion
      // says so in as many words, and the count is where it shows up.
      failed += 1;
      logger.error('Trial reminder dispatch failed', { relationId: row.relationId, threshold: row.threshold, error: String(error) });
    }
  }

  // EXPIRY, AFTER the warnings (see the note at the top). Every tenant in scope,
  // not only the ones that had a reminder due: a tenant whose trials all ran out
  // weeks ago has nothing to warn about and everything to move.
  let expired = 0;
  for (const orgId of inScope) {
    try {
      expired += await runWithOrg(orgId, () => expireTrials(orgId, now));
    } catch (error) {
      failed += 1;
      logger.error('Trial expiry failed for one organisation', { orgId, error: String(error) });
    }
  }

  return { considered: due.length, sent, skipped, failed, expired, orgs: inScope.length };
}

const tasks = new Map<string, ReturnType<typeof cron.schedule>>();

/**
 * Register the daily trial sweep in this server process. Idempotent — a retried
 * call from `/api/cron/start` is harmless.
 *
 * Registered from `/api/cron/start` rather than from `initCronJobs()`, the same
 * way the newsletter cron (#1469), the dead-letter alert (#1674), the retention
 * prune (#1678) and the usage rollup (#1750) are: this module imports
 * `emailService`, so registering it inside `initCronJobs` would close a one-way
 * import into a cycle.
 *
 * 05:20 UTC — clear of every other daily slot (02:40 the usage rollup, 03:20 the
 * retention prune, 06:45 the dead-letter alert, 07:30 activity digests,
 * 08:15/08:30 the Monday weeklies, 09:00 the reminder batch). Early enough that
 * a trial that ran out overnight has already flipped to TRIAL_EXPIRED before
 * anyone opens the board, and ahead of the mail-heavy slots so the reminder is
 * not queued behind them.
 *
 * node-cron is the carrier only until the leader-elected scheduler (#1676)
 * lands; `runTrialReminders()` is the handler either way.
 */
export function initTrialRemindersCron() {
  if (tasks.has('trial-reminders')) return;

  const task = cron.schedule('20 5 * * *', async () => {
    try {
      const result = await runTrialReminders();
      // A tick that sent, skipped, failed or expired something is worth a line;
      // a quiet one is not — the same discipline as the sibling jobs.
      if (result.sent > 0 || result.skipped > 0 || result.failed > 0 || result.expired > 0) {
        logger.warning('Trial reminders ran', { ...result });
      }
    } catch (error) {
      logger.error('Trial reminders cron failed', { error: String(error) });
    }
  });
  tasks.set('trial-reminders', task);
}
