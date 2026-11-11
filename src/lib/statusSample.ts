// The status page's sampler and reader (#1604) — the only Prisma-aware half;
// the rules are in `statusRule.ts`.
//
// `recordStatusSample()` is the `status.sample` job body (every 5 min through
// the scheduler, src/lib/jobs/schedules.ts). An upsert on the slot start, so a
// rerun of the same slot rewrites one row instead of adding a second, and
// samples older than the window (plus a margin) are deleted on the way.
import { prisma } from '@/lib/prisma';
import { getEmailHealth } from '@/lib/emailHealth';
import { jobQueueHealth } from '@/lib/jobs/health';
import { WINDOW_DAYS, buildReport, gradeJobs, gradeMail, slotOf, type StatusReport } from '@/lib/statusRule';

const RETAIN_DAYS = WINDOW_DAYS + 10;

export async function recordStatusSample(now: Date = new Date()): Promise<{ written: number; pruned: number }> {
  const [mail, jobs] = await Promise.all([getEmailHealth(), jobQueueHealth()]);
  const at = slotOf(now);
  const data = { mail: gradeMail(mail, now), jobs: gradeJobs(jobs) };
  await prisma.statusSample.upsert({ where: { at }, create: { at, ...data }, update: data });
  const { count } = await prisma.statusSample.deleteMany({
    where: { at: { lt: new Date(now.getTime() - RETAIN_DAYS * 24 * 60 * 60 * 1000) } },
  });
  return { written: 1, pruned: count };
}

/** The window's samples → the page's report. ~26k rows at most, three short columns. */
export async function statusReport(now: Date = new Date()): Promise<StatusReport> {
  const samples = await prisma.statusSample.findMany({
    where: { at: { gte: new Date(now.getTime() - (WINDOW_DAYS + 1) * 24 * 60 * 60 * 1000) } },
    select: { at: true, mail: true, jobs: true },
  });
  return buildReport(samples, now);
}
