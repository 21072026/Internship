// The announcement reach loader (#1921, slice 2). Server-only: the rule is pure
// in announcementReachRule.ts; this reads the bell rows it judges and the org's
// retention cutoff. Counts only — the query groups by (announcement, read) and
// never selects a user.

import { prisma } from '@/lib/prisma';
import { notificationRetentionCutoff } from '@/lib/notificationRetention';
import { notificationWindowFor } from '@/lib/notificationRetentionWindow';
import { announcementSentAt, readReach, type ReadReach } from '@/lib/announcementReachRule';

export interface ReachAnnouncement {
  id: string;
  status: string;
  scheduledAt: Date | null;
  createdAt: Date;
}

/** Read reach per announcement, for announcements of one org. */
export async function announcementReach(rows: readonly ReachAnnouncement[], orgId: string | null, now: Date = new Date()): Promise<Map<string, ReadReach>> {
  const ids = rows.map((a) => a.id);
  const [counts, windowDays] = await Promise.all([
    ids.length
      ? prisma.notification.groupBy({ by: ['announcementId', 'read'], where: { announcementId: { in: ids } }, _count: { _all: true } })
      : Promise.resolve([]),
    notificationWindowFor(orgId),
  ]);
  const tally = new Map<string, { delivered: number; read: number }>();
  for (const c of counts) {
    if (!c.announcementId) continue;
    const t = tally.get(c.announcementId) ?? { delivered: 0, read: 0 };
    t.delivered += c._count._all;
    if (c.read) t.read += c._count._all;
    tally.set(c.announcementId, t);
  }
  const cutoff = notificationRetentionCutoff(now, windowDays);
  return new Map(
    rows.map((a) => {
      const t = tally.get(a.id) ?? { delivered: 0, read: 0 };
      return [a.id, readReach({ status: a.status, sentAt: announcementSentAt(a), ...t }, cutoff)];
    }),
  );
}
