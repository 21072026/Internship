// "A lead was assigned to you" — the notice a sales owner gets when somebody
// ELSE puts a new lead on their book (#3968).
//
// The relation writers of the marketing product (createMarketingAccount, the
// web-inquiry conversion) are silent on purpose: they are also the import and
// the integration ingest, which create leads by the hundred for the default
// owner and must not mail per row. The paths where a PERSON or a single web
// request picks the owner call this after a successful create instead, so the
// owner hears about the lead the way an admin's direct assignment already told
// them (relationCreate.ts → sendMenteeAssignedEmail).
//
// Same channels and the same opt-outs as that notice: the in-app bell always,
// the mail under the `mentorship` preference and the `mentee-assigned` group.
// Never to the person who did it (a rep's own lead, an admin taking a lead
// themself), and only to staff — the owner of a lead is an ADMIN or a MENTOR
// (a sales rep), and the customer-mail lock would refuse anyone else anyway.
// Never throws: the lead exists either way, and a failed notice costs at most
// the notice.
import { prisma } from '@/lib/prisma';
import { notify } from '@/lib/notify';
import { emailAllowed } from '@/lib/notificationPrefs';
import { emailGroupAllowedForCategory } from '@/lib/emailGroups';
import { logger } from '@/lib/logger';
import { sendMenteeAssignedEmail } from '@/services/emailService';
import { leadAssignedNoticeDue } from '@/lib/leadAssignedNoticeRule';

export async function announceLeadAssigned(input: {
  ownerId: string;
  /** Who did it; null for a sessionless path (the default owner of a web request). */
  actorId: string | null;
  leadName: string;
}): Promise<void> {
  try {
    const owner = await prisma.user.findUnique({
      where: { id: input.ownerId },
      select: { id: true, role: true, orgId: true, fullName: true, email: true, isActive: true, emailNotifications: true, notificationPrefs: true },
    });
    if (!owner || !owner.isActive) return;
    if (!leadAssignedNoticeDue({ ownerId: owner.id, ownerRole: owner.role, actorId: input.actorId })) return;
    await notify(owner.id, 'mentorship_request.menteeAssigned', { menteeName: input.leadName }, '/mentor');
    if (owner.email && emailAllowed(owner, 'mentorship') && emailGroupAllowedForCategory(owner, 'mentee-assigned')) {
      await sendMenteeAssignedEmail({ mentorName: owner.fullName, menteeName: input.leadName, orgId: owner.orgId, userId: owner.id });
    }
  } catch (e) {
    logger.error('lead_assigned_notice.failed', { error: e instanceof Error ? e.message : String(e) });
  }
}
