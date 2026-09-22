import cron from 'node-cron';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { runWithOrg } from '@/lib/orgContext';
import { notify } from '@/lib/notify';
import { notificationLink, type NotificationRole } from '@/lib/notificationLink';
import { emailAllowed, notificationCategoryAllowed } from '@/lib/notificationPrefs';
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
 *
 * SO THIS IS A DOCUMENTED DEVIATION FROM #2410, not a claim that the checkbox
 * is met: "the rest rolls to the next tick" is true of the RECORD and false of
 * the MARK. The remedy is operational and deliberate — nothing is claimed for a
 * shed pair, the sweep logs how many it shed and at which rungs, and the named
 * endpoint (`/api/cron?job=trial-reminders`, optionally `&orgId=`) re-runs it
 * immediately. Raising the cap instead would trade a shared sending domain's
 * reputation for the tail of one unusually bunched day.
 */
export const TRIAL_REMINDER_MAX_PER_RUN = 50;

/**
 * Records moved out of TRIAL_ACTIVE in ONE tick, across every tenant.
 *
 * The expiry pass used to be unbounded, which was fine while the only way into
 * a trial stage was a human dragging a card — and stops being fine the moment
 * an import lands an existing customer base with historical trial dates
 * (#2405). The first tick after that is one conditional `updateMany` per
 * record, awaited inside whatever called the sweep — including
 * `GET /api/cron?job=trial-reminders`, which an operator triggers by hand.
 *
 * Unlike the reminder cap above, this one genuinely DOES roll over: the
 * predicate is `trialEndsAt < startOfToday`, which is still true tomorrow, so a
 * record this tick did not reach is picked up by the next one unchanged. A
 * backlog therefore drains over a few ticks instead of in one long request, and
 * an operator who wants it drained now re-runs the named endpoint.
 */
export const TRIAL_EXPIRY_MAX_PER_RUN = 500;

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
  /**
   * Everything that went wrong, counted ONE PER FAILURE rather than one per
   * pair: a channel send that threw, a pair whose dispatch threw outright, a
   * tenant whose candidate query threw, a tenant whose expiry threw.
   *
   * The buckets therefore do NOT partition `considered`, on purpose. #2415's
   * acceptance criterion is that a single send failure does not drop the job
   * *and shows up in this count* — so a pair whose bell landed and whose mail
   * threw is counted in both `sent` and `failed`, because an operator reading
   * this JSON needs to see the broken channel. Rolling it into `sent` alone is
   * how a total mail outage reports itself as a perfect run.
   */
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
 * A per-recipient send failure is caught here and never fails the tick — but it
 * is REPORTED here rather than only logged (`failures`), because "a single send
 * error does not drop the job, and is reflected in the `failed` count" is one
 * acceptance criterion and not two. A dispatch whose every attempted channel
 * threw is 'failed', not 'skipped': nothing was deliberate about it.
 */
type DispatchOutcome = 'sent' | 'skipped' | 'failed';

interface DispatchResult {
  outcome: DispatchOutcome;
  /** Individual channel sends that threw. Folded into the tick's `failed`. */
  failures: number;
}

const skip = (): DispatchResult => ({ outcome: 'skipped', failures: 0 });

async function dispatchReminder(row: DueTrialReminderRow): Promise<DispatchResult> {
  const { relation, threshold } = row;
  const orgId = relation.orgId;
  if (!orgId) return skip();

  const recipients = await recipientsFor(orgId, relation.mentorId);
  if (recipients.length === 0) {
    logger.warning('Trial reminder has no reachable recipient', { relationId: relation.id, threshold });
    return skip();
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
    return skip();
  }

  const claim = await prisma.trialReminder.createMany({
    data: [{ orgId, relationId: relation.id, threshold }],
    skipDuplicates: true,
  });
  // Another tick won it. Not an error and not a miss — exactly one of us was
  // supposed to lose.
  if (claim.count === 0) return skip();

  let delivered = 0;
  let attempted = 0;
  let failures = 0;
  for (const user of recipients) {
    const link = notificationLink(user.role as NotificationRole, 'relation', {
      relationId: relation.id,
      menteeId: relation.menteeId,
    });
    // The bell and the mail are gated SEPARATELY, on the same 'deadlines'
    // category: `notificationCategoryAllowed` is the in-app switch,
    // `emailAllowed` the e-mail one, and `emailGroupAllowedForCategory` the
    // group behind the EXISTING 'stage-deadline' category. Opting out of one is
    // not opting out of the other, and neither adds a category or a preference
    // key (#2412).
    //
    // The gate is applied HERE, from the prefs already selected, rather than by
    // handing the category to `notifyIfAllowed`. That helper returns void — it
    // reports nothing about whether a row was written — so counting a call to
    // it as a delivery counts a MUTED recipient as one, which made the
    // documented `skipped` case ("muted both channels") unreachable and let a
    // silent pair spend the per-tick sending budget. `notify()` is what
    // `notifyIfAllowed` calls once the same predicate passes, so the behaviour
    // is identical for everyone who has not opted out, minus a second read of
    // prefs we are already holding.
    if (notificationCategoryAllowed(user, 'deadlines')) {
      attempted += 1;
      // `notify()` never throws by contract (a failed bell must not break the
      // action that triggered it), so a write that fails is logged there and
      // cannot be counted here. The mail below is the channel `failures`
      // actually observes.
      await notify(user.id, 'trial.endingSoon', { company: accountName, days: String(threshold) }, link);
      delivered += 1;
    }

    if (emailAllowed(user, 'deadlines') && emailGroupAllowedForCategory(user, 'stage-deadline')) {
      attempted += 1;
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
        failures += 1;
        logger.error('Trial reminder email failed', { relationId: relation.id, userId: user.id, error: String(error) });
      }
    }
  }

  // Nothing was even tried: every recipient muted every channel. That is the
  // one genuinely deliberate silence, and the only thing `skipped` means here.
  if (delivered > 0) return { outcome: 'sent', failures };
  return { outcome: attempted === 0 ? 'skipped' : 'failed', failures };
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
 * AND THAT HAS A SECOND CONSEQUENCE, which is bigger than the missing history
 * row and is written down here so nobody rediscovers it from a bug report.
 * `StatusChange` is the ONLY thing the stage clock reads: `stageEnteredAt()`
 * (src/lib/stageClock.ts) takes the newest real move and falls back to
 * `startDate`, `GET /api/mentorship` derives `daysInStage` from the same row,
 * and `computeStageAging()` counts a completed stage visit from a PAIR of them.
 * A record auto-moved here therefore reports the age of the whole TRIAL — not
 * the age of the decision — as its time in TRIAL_EXPIRED on the mentor board,
 * the admin board and the candidate detail, and its TRIAL_ACTIVE visit is never
 * closed for the aging report. That matters because #2418's attention-queue row
 * sits next to exactly that number.
 *
 * Fixing it properly means an actor that is not a `User`, i.e. making
 * `StatusChange.changedById` nullable the way `ActivityLog.actorId` already is,
 * plus the two pages that render `changedBy.fullName`. That is a change to a
 * shared audit model and belongs in its own reviewed diff (#2527) rather than
 * riding in on a cron job — and #2417 enumerated exactly two options, of which
 * this is one. Attributing the move to a real human instead (the owner, an org
 * admin) was rejected outright: it would print a name next to something that
 * person did not do, and `accountErasure.ts` would delete the pipeline's
 * history along with that account.
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
    // Bounded, and safely so — see TRIAL_EXPIRY_MAX_PER_RUN. Oldest first, so a
    // backlog drains in the order it accumulated instead of in whatever order
    // the index hands back.
    orderBy: { trialEndsAt: 'asc' },
    take: TRIAL_EXPIRY_MAX_PER_RUN,
  });
  if (due.length === 0) return 0;
  if (due.length === TRIAL_EXPIRY_MAX_PER_RUN) {
    logger.warning('Trial expiry hit the per-tick bound; the remainder rolls to the next tick', {
      orgId,
      bound: TRIAL_EXPIRY_MAX_PER_RUN,
    });
  }

  // One resolution for the whole batch: the SLA of the destination stage does
  // not vary by record.
  const deadline = await stageDeadlineUpdate(orgId, expiredKey, now);

  // The conditional update stays one statement per record — it is what lets a
  // human win, and a single `updateMany` over the whole set could not say WHICH
  // rows it moved, so the audit rows would be guesses. The audit rows
  // themselves are one batched insert rather than one per record, which halves
  // the round trips without giving anything up.
  const moved: string[] = [];
  for (const relation of due) {
    const claim = await prisma.mentorshipRelation.updateMany({
      where: { id: relation.id, pipelineStatus: activeKey },
      data: { pipelineStatus: expiredKey, ...(deadline ?? {}) },
    });
    if (claim.count === 0) continue;
    moved.push(relation.id);
  }
  if (moved.length === 0) return 0;

  await prisma.auditLog
    .createMany({
      data: moved.map((id) => ({ actorId: 'system', action: 'trial.expire', targetId: id })),
    })
    .catch((error) => logger.error('Trial expiry audit rows failed', { orgId, count: moved.length, error: String(error) }));

  return moved.length;
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
  const shed: number[] = [];
  for (const row of due) {
    if (sent >= TRIAL_REMINDER_MAX_PER_RUN) {
      skipped += 1;
      shed.push(row.threshold);
      continue;
    }
    const orgId = row.relation.orgId;
    try {
      const { outcome, failures } = orgId
        ? await runWithOrg(orgId, () => dispatchReminder(row))
        : await dispatchReminder(row);
      // One send failing must not drop the job AND must be visible in the
      // counts — #2415's acceptance criterion is both halves of that sentence.
      // A pair can be 'sent' and still carry failures (the bell landed, the
      // mail did not); a total mail outage must not report itself as a perfect
      // run.
      failed += failures;
      if (outcome === 'sent') sent += 1;
      else if (outcome === 'skipped') skipped += 1;
      // 'failed' pairs are already in `failed`, once per broken channel.
    } catch (error) {
      failed += 1;
      logger.error('Trial reminder dispatch failed', { relationId: row.relationId, threshold: row.threshold, error: String(error) });
    }
  }
  // The cap biting is not a quiet event. A shed mark is NOT re-offered at the
  // same rung tomorrow (see TRIAL_REMINDER_MAX_PER_RUN), so this line is the
  // operator's cue to re-run the named endpoint — the shed pairs were never
  // claimed, so a second run picks them up.
  if (shed.length > 0) {
    logger.warning('Trial reminder cap reached; marks were shed without being claimed', {
      cap: TRIAL_REMINDER_MAX_PER_RUN,
      shed: shed.length,
      thresholds: [...new Set(shed)].sort((a, b) => a - b).join(','),
    });
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
