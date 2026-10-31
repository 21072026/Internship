import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { notifyEvent } from '@/lib/notifications/router';
import { chatCapableUsers } from '@/lib/notifications/adapters/chat';
import { emailGroupAllowedForCategory } from '@/lib/emailGroups';

/**
 * Offer a survey invitation on chat as well (#1953): the campaign has just
 * minted the invitation and mailed its link; a person with a confirmed chat
 * identity also gets a card whose "Answer now" starts the in-chat flow
 * (src/lib/chat/interactions/actions.ts) and whose link opens the same page
 * the mail does.
 *
 * Nothing new is decided here. The invitation, its token, its expiry and its
 * reminders (capped at two, #1889) are the engine's; answering in chat stamps
 * the same `respondedAt`, so a reminder that was due no longer goes out. The
 * card is withheld from anyone who switched survey mail off — the switch is
 * about being asked, not about the channel.
 *
 * NEVER THROWS: a chat failure must not cost the person their invitation.
 */
export async function offerSurveyInChat(userId: string, invitationId: string, url: string): Promise<void> {
  try {
    if (!(await chatCapableUsers([userId])).has(userId)) return;
    const prefs = await prisma.user.findUnique({ where: { id: userId }, select: { emailNotifications: true, notificationPrefs: true } });
    if (!prefs || !emailGroupAllowedForCategory(prefs, 'survey-invite')) return;
    await notifyEvent(userId, 'survey.invited', {}, {
      channels: ['chat'],
      dedupeKey: `survey-invite:${invitationId}`,
      chatCard: {
        subjectKey: `survey:${invitationId}`,
        actionUrl: url,
        supersede: false,
        buttons: [{ label: 'answerSurvey', actionId: 'survey.start', value: invitationId }],
      },
    });
  } catch (e) {
    logger.warning('survey chat offer failed', { invitationId, error: String(e) });
  }
}
