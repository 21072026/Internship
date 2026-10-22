import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { logActivity } from '@/lib/activity';
import { runWithOrg } from '@/lib/orgContext';
import { runRosterFeed } from '@/lib/rosterIngestStore';
import type { RosterIngestResult } from '@/lib/rosterIngest';
import { alertRosterFailure } from '@/lib/rosterAlert';
import { ROSTER_CLAIM_MS, isFeedDue, shouldPauseFeed, ROSTER_FAILURE_PAUSE_THRESHOLD } from '@/lib/rosterFeed';

// Running a roster feed on purpose: from the console ("Run now", "Run now (dry
// run)", "Approve and apply") or from the one scheduled waker (#1967).
//
// THE CLAIM. Exactly one process runs a feed at a time — the waker on two
// replicas, a waker tick and an admin's click, two admins' clicks. The claim
// is ONE conditional UPDATE on the feed row (`claimedUntil` empty or expired →
// now + ROSTER_CLAIM_MS); whoever's UPDATE matched runs, everybody else is told
// "already running". Not read-then-write: two readers would both see it free.
// The claim is cleared when the run ends and expires on its own when a process
// dies mid-run, so a crash never wedges a feed.
//
// THE SCHEDULE is ONE queued job, `roster.sweep`, every five minutes
// (src/lib/jobs/schedules.ts, #1676's scheduler under the 'scheduler' lease;
// handler in src/jobs/index.ts) — not one timer per feed.

export interface RunFeedOptions {
  dryRun?: boolean;
  approved?: boolean;
  expectFileHash?: string;
  now?: Date;
}

export type RunFeedOutcome =
  | { status: 'claimed_elsewhere' }
  | { status: 'done'; result: RosterIngestResult }
  | { status: 'error'; message: string };

/** Take the feed's claim. True only for the one caller whose UPDATE matched. */
export async function claimFeed(feedId: string, now: Date = new Date()): Promise<boolean> {
  const { count } = await runWithOrg(null, () =>
    prisma.rosterFeed.updateMany({
      where: { id: feedId, OR: [{ claimedUntil: null }, { claimedUntil: { lt: now } }] },
      data: { claimedUntil: new Date(now.getTime() + ROSTER_CLAIM_MS) },
    }),
  );
  return count === 1;
}

export async function releaseFeed(feedId: string): Promise<void> {
  await runWithOrg(null, () => prisma.rosterFeed.updateMany({ where: { id: feedId }, data: { claimedUntil: null } }));
}

function failed(result: RosterIngestResult | null, error: string | null): boolean {
  return Boolean(error) || result?.run?.status === 'FAILED';
}

/**
 * The bookkeeping after a real (non-dry) run: when it last ran, the failure
 * streak, the auto-pause after ROSTER_FAILURE_PAUSE_THRESHOLD failures in a
 * row, and the failure alert. A run a safety valve stopped neither counts as a
 * failure nor resets the streak: it is the file that was wrong, not the feed.
 */
async function recordOutcome(
  feed: { id: string; orgId: string; name: string },
  result: RosterIngestResult | null,
  error: string | null,
): Promise<void> {
  if (failed(result, error)) {
    const message = error ?? 'One or more rows could not be imported.';
    await runWithOrg(null, () =>
      prisma.rosterFeed.updateMany({ where: { id: feed.id }, data: { consecutiveFailures: { increment: 1 } } }),
    );
    const row = await runWithOrg(null, () =>
      prisma.rosterFeed.findUnique({ where: { id: feed.id }, select: { consecutiveFailures: true, enabled: true } }),
    );
    if (row && row.enabled && shouldPauseFeed(row.consecutiveFailures)) {
      const reason = `Paused after ${ROSTER_FAILURE_PAUSE_THRESHOLD} failed runs in a row. Last error: ${message}`.slice(0, 1000);
      await runWithOrg(null, () =>
        prisma.rosterFeed.updateMany({ where: { id: feed.id }, data: { enabled: false, pausedReason: reason } }),
      );
      await logActivity({
        action: 'roster.feed_paused',
        level: 'warning',
        orgId: feed.orgId,
        targetType: 'roster_feed',
        targetId: feed.id,
        detail: feed.name.slice(0, 191),
      });
    }
    await alertRosterFailure(feed, message, Boolean(row && shouldPauseFeed(row.consecutiveFailures)));
    return;
  }
  if (result && result.outcome !== 'ABORTED_SAFETY' && result.outcome !== 'LOCKED') {
    await runWithOrg(null, () =>
      prisma.rosterFeed.updateMany({ where: { id: feed.id }, data: { consecutiveFailures: 0 } }),
    );
  }
}

/**
 * Run one feed now, under its claim. Never throws: a run that came apart is
 * `{ status: 'error' }` with a message safe to show an admin (the engine's own
 * messages never carry the credential).
 */
export async function runFeed(feedId: string, options: RunFeedOptions = {}): Promise<RunFeedOutcome> {
  const now = options.now ?? new Date();
  const feed = await runWithOrg(null, () =>
    prisma.rosterFeed.findUnique({ where: { id: feedId }, select: { id: true, orgId: true, name: true } }),
  );
  if (!feed) return { status: 'error', message: 'No such feed.' };
  if (!(await claimFeed(feedId, now))) return { status: 'claimed_elsewhere' };
  try {
    if (!options.dryRun) {
      await runWithOrg(null, () => prisma.rosterFeed.updateMany({ where: { id: feedId }, data: { lastRunAt: now } }));
    }
    let result: RosterIngestResult | null = null;
    let error: string | null = null;
    try {
      result = await runRosterFeed(feedId, {
        dryRun: options.dryRun,
        approved: options.approved,
        expectFileHash: options.expectFileHash,
      });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      logger.warning('Roster feed run failed', { feedId, error });
    }
    if (!options.dryRun) await recordOutcome(feed, result, error);
    return result ? { status: 'done', result } : { status: 'error', message: error ?? 'The run failed.' };
  } finally {
    await releaseFeed(feedId);
  }
}

/**
 * The waker's handler: run every enabled feed whose schedule is due. One feed
 * failing never stops the others, and a feed another process holds is simply
 * skipped — it is being run.
 */
export async function sweepDueRosterFeeds(
  now: Date = new Date(),
): Promise<{ feedId: string; status: RunFeedOutcome['status'] }[]> {
  const feeds = await runWithOrg(null, () =>
    prisma.rosterFeed.findMany({
      where: { enabled: true, cronExpression: { not: null } },
      select: { id: true, enabled: true, cronExpression: true, lastRunAt: true, createdAt: true },
    }),
  );
  const out: { feedId: string; status: RunFeedOutcome['status'] }[] = [];
  for (const feed of feeds) {
    if (!isFeedDue(feed, now)) continue;
    const outcome = await runFeed(feed.id, { now });
    out.push({ feedId: feed.id, status: outcome.status });
  }
  return out;
}
