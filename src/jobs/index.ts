// Every queue handler in the product, registered by name (#1673). The worker
// route imports this file once; a job whose name is not registered here is
// never claimed and is reported at worker start (`checkHandlers()`).
//
// One `registerJob()` per name. Handlers are at-least-once — each one states
// what makes a second run harmless. The schedule that ENQUEUES them is #1676's
// registry; #1677 moves the node-cron bodies in here, one file per handler.
import { registerJob } from '@/lib/jobs/registry';
import { pruneJobRuns } from '@/lib/jobs/queue';
import { runDeadLetterAlert } from '@/lib/jobs/dlqAlert';
import { runAuditDrains } from '@/lib/auditDrain';
import { runApiImport } from '@/lib/api/v1Imports';
import { runApiExport } from '@/lib/api/v1Exports';

let registered = false;

export function registerAllJobs(): void {
  if (registered) return;
  registered = true;

  // A DELETE by age: a second run deletes nothing new.
  registerJob('jobs.pruneRuns', async (payload) => {
    const days = typeof payload?.retentionDays === 'number' && Number.isFinite(payload.retentionDays) ? payload.retentionDays : undefined;
    return { deleted: await pruneJobRuns(days) };
  });

  // Reads the queue and mails one digest. Not idempotent on its own — a second
  // run mails a second digest — so it is enqueued under a per-day
  // idempotencyKey by its schedule, and maxAttempts bounds the rest.
  registerJob('jobs.deadLetterAlert', async () => {
    const run = await runDeadLetterAlert();
    return { total: run.total, sent: run.sent ? 1 : 0 };
  });

  // The cursor moves only on a 2xx and receivers dedupe on the row id
  // (docs/audit-stream.md), so a repeated tick re-ships at most one batch.
  registerJob('audit.drain', async () => ({ ...(await runAuditDrains()) }));

  // A DONE or FAILED import is left alone, and a row the dead attempt already
  // created is found by its e-mail and skipped — nothing is created twice.
  registerJob(
    'api.import.candidates',
    async (payload, { job, attempt, signal }) => ({ ...(await runApiImport(payload.importId, { signal, attempt, maxAttempts: job.maxAttempts })) }),
    { timeoutMs: 10 * 60 * 1000 },
  );
  // A READY or FAILED export is left alone and the file is stored in one
  // guarded update, so a repeated run rewrites at most an unfinished one.
  registerJob('api.export', async (payload, { signal }) => ({ ...(await runApiExport(payload.exportId, signal)) }), {
    timeoutMs: 10 * 60 * 1000,
  });
}
