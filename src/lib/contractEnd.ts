import { prisma } from '@/lib/prisma';
import { notifyIfAllowed } from '@/lib/notify';
import { notificationLink, type NotificationRole } from '@/lib/notificationLink';
import { shellCapabilities } from '@/lib/shellCapabilities';
import { CONTRACT_STAGE_KEY, contractEndReminderDue } from '@/lib/contractEndRule';

// The end-day bell of a won customer's notice period (#2841); the rule is
// src/lib/contractEndRule.ts. Run from the daily trial sweep, per MARKETING
// org. One bell per record and date: the claim is a conditional UPDATE on
// `contractEndRemindedAt IS NULL`, so an overlapping tick cannot ring twice,
// and moving the date (PATCH …/contract-end) clears the claim. It NEVER moves
// the stage — the bell asks a human to decide.

export async function ringContractEnds(orgId: string, now: Date): Promise<number> {
  const candidates = await prisma.mentorshipRelation.findMany({
    where: {
      orgId,
      status: 'ACTIVE',
      pipelineStatus: CONTRACT_STAGE_KEY,
      contractEndsAt: { not: null, lte: now },
      contractEndRemindedAt: null,
    },
    select: {
      id: true,
      menteeId: true,
      mentorId: true,
      pipelineStatus: true,
      contractEndsAt: true,
      contractEndRemindedAt: true,
      company: { select: { name: true } },
      mentee: { select: { fullName: true } },
      mentor: { select: { role: true } },
    },
  });
  const capabilities = candidates.length > 0 ? await shellCapabilities(orgId) : [];
  let rung = 0;
  for (const r of candidates) {
    if (!contractEndReminderDue({ ...r, now })) continue;
    const claimed = await prisma.mentorshipRelation.updateMany({
      where: { id: r.id, contractEndRemindedAt: null, contractEndsAt: r.contractEndsAt },
      data: { contractEndRemindedAt: now },
    });
    if (claimed.count === 0) continue;
    const link = notificationLink(r.mentor.role as NotificationRole, 'relation', { relationId: r.id, menteeId: r.menteeId }, { capabilities });
    await notifyIfAllowed(r.mentorId, 'deadlines', 'contract.endsToday', { company: r.company?.name ?? r.mentee.fullName }, link);
    rung += 1;
  }
  return rung;
}
