import { logger } from '@/lib/logger';
import { notifyEvent } from '@/lib/notifications/router';
import { chatCapableUsers } from '@/lib/notifications/adapters/chat';

/**
 * The post-meeting card (#1953): a relation meeting that took place has just
 * been logged with the placeholder note (src/lib/meetingAutoLog.ts), and its
 * mentor — when they confirmed a chat identity — is offered "Add notes" right
 * there. The card's action edits THAT row through updateInteraction(), the
 * app's own edit path (src/lib/chat/interactions/actions.ts), so a session is
 * never logged twice: the meeting's log is the log.
 *
 * Only offered when the log carries the placeholder: when the pair already
 * wrote minutes (#1849) the log has them, and there is nothing to ask.
 *
 * NEVER THROWS: a chat failure must not fail the auto-log that called it.
 */
export async function offerMeetingLogInChat(opts: {
  mentorId: string;
  relationId: string;
  meetingId: string;
  interactionId: string;
  title: string;
}): Promise<void> {
  try {
    if (!(await chatCapableUsers([opts.mentorId])).has(opts.mentorId)) return;
    await notifyEvent(opts.mentorId, 'meeting.logPrompt', { title: opts.title, relationId: opts.relationId }, {
      channels: ['chat'],
      dedupeKey: `meeting-log:${opts.meetingId}`,
      chatCard: {
        subjectKey: `meeting-log:${opts.meetingId}`,
        actionUrl: null,
        supersede: false,
        buttons: [{ label: 'addNotes', actionId: 'interaction.note', value: opts.interactionId }],
      },
    });
  } catch (e) {
    logger.warning('meeting log chat offer failed', { meetingId: opts.meetingId, error: String(e) });
  }
}
