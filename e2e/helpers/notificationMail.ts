// Run the router's queued e-mail jobs for some recipients NOW, in this process
// (#1711). A spec that drives a sweep in-process used to get its mail sent in
// the same call; behind the router the mail is a `notification.email` job the
// app's worker picks up on its own schedule — which, on a busy local queue, can
// be well over a minute. Running the very same handler here keeps the spec
// deterministic without changing what is sent: the claim is guarded, so the
// worker's later attempt on the same job reads `claimed_elsewhere` and sends
// nothing twice.
import { prisma } from './db';
import { runNotificationEmail } from '@/lib/notifications/emailJob';
import type { JobRecord } from '@/lib/jobs/queue';

export async function drainNotificationMail(userIds: string[]): Promise<number> {
  const wanted = new Set(userIds);
  const jobs = await prisma.job.findMany({ where: { name: 'notification.email', status: 'PENDING' }, orderBy: { createdAt: 'asc' } });
  let ran = 0;
  for (const job of jobs) {
    const payload = job.payload as Parameters<typeof runNotificationEmail>[0];
    if (!wanted.has((payload as { userId?: string }).userId ?? '')) continue;
    await runNotificationEmail(payload, job as unknown as JobRecord);
    ran++;
  }
  return ran;
}
