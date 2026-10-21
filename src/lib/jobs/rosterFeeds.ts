// The roster-feed waker (#1967). ONE timer for every feed: every five minutes
// it runs the feeds whose cron expression is due (`sweepDueRosterFeeds`), each
// under its own claim, so a second replica's tick or an admin's "Run now" at
// the same moment cannot run a feed twice. Not one timer per feed — an
// in-process timer dies with every redeploy, and the waker catches up on the
// next tick instead.
//
// node-cron is the carrier only until the leader-elected scheduler (#1675 /
// #1676) lands; `sweepDueRosterFeeds()` is the handler either way. Registered
// from /api/cron/start, never from initCronJobs, to keep the import graph
// one-way (the runner's alert imports emailService).
import cron from 'node-cron';
import { logger } from '@/lib/logger';
import { ROSTER_WAKER_CRON } from '@/lib/rosterFeed';
import { sweepDueRosterFeeds } from '@/lib/rosterFeedRunner';

const tasks = new Map<string, cron.ScheduledTask>();

export function initRosterFeedsCron() {
  if (tasks.has('roster-feeds')) return;
  const task = cron.schedule(ROSTER_WAKER_CRON, async () => {
    try {
      const ran = await sweepDueRosterFeeds();
      // A quiet tick is not worth a line; one that ran a feed is.
      if (ran.length) logger.warning('Roster feeds ran', { feeds: ran.length, outcomes: ran.map((r) => r.status) });
    } catch (error) {
      logger.error('Roster feed waker failed', { error: String(error) });
    }
  });
  tasks.set('roster-feeds', task);
}
