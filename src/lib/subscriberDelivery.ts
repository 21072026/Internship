import { prisma } from '@/lib/prisma';
import { runUnscoped } from '@/lib/tenantAmbient';
import { findUserInWorld, worldOfOrg } from '@/lib/userWorld';
import { emailGroupAllowedForCategory } from '@/lib/emailGroups';

export const SUBSCRIBER_RETENTION_DAYS = 365;
// Called both before prepare/queue and immediately before a queued transmission.
// Missing rows, changed addresses/tenants, expiry and database failures fail CLOSED.
export async function subscriberDeliveryAllowed(id: string, to: string, orgId: string | null | undefined, category?: string): Promise<boolean> {
  const row = await runUnscoped(() => prisma.subscriber.findUnique({ where: { id } }));
  if (!row || row.email !== to.trim().toLowerCase() || row.orgId !== orgId || !row.consent || row.unsubscribedAt) return false;
  if (category === 'consent') return !row.confirmedAt && !!row.confirmationExpiresAt && row.confirmationExpiresAt > new Date();
  if (!row.confirmedAt || row.createdAt.getTime() <= Date.now() - SUBSCRIBER_RETENTION_DAYS * 86400000) return false;
  // An interest signup never overrides an existing account's master/group opt-out.
  // Check again at transmission, including approved drafts without a User id.
  const user = await findUserInWorld(row.email, await worldOfOrg(row.orgId), { emailNotifications: true, notificationPrefs: true });
  return !user || emailGroupAllowedForCategory(user, category);
}
