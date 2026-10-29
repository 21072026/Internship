import { prisma } from '@/lib/prisma';
import { notify } from '@/lib/notify';
import { tenantAdminIds } from '@/lib/tenantAdmins';

// FREE CORE (#1745, #3270): when a participant hits a plan cap, the participant
// is told only that there is no room right now, and the commercial half — the
// cap, the plan, the way out — goes to the org's admins here. At most one
// notification of each kind per admin per day, so a busy link or a mentee
// retrying the form does not flood the bell.
export type HeldByPlanEvent = 'plan_limit.application_held' | 'plan_limit.project_held';

export async function notifyAdminsHeldByPlan(orgId: string | null, type: HeldByPlanEvent, limit: number | null): Promise<void> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  for (const adminId of await tenantAdminIds(orgId)) {
    const recent = await prisma.notification.findFirst({
      where: { userId: adminId, type, createdAt: { gte: since } },
      select: { id: true },
    });
    if (!recent) await notify(adminId, type, { limit: String(limit ?? '') }, '/admin/billing');
  }
}
