import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { notifyEvent } from '@/lib/notifications/router';
import { chatCapableUsers } from '@/lib/notifications/adapters/chat';
import { emailGroupAllowedForCategory } from '@/lib/emailGroups';

type Side = { id: string; fullName: string; emailNotifications?: boolean | null; notificationPrefs?: unknown };

/**
 * The pairing DM (#1946): the moment a pair exists, each side who linked a
 * chat identity gets one card introducing the other — the mentee with "Book a
 * session" (the `meeting.book` action, #1951), the mentor with the mentee's
 * top skills, which the app's mentee page already shows them. Nothing else of
 * either profile travels.
 *
 * Beside, never instead of, the bell and the mail announceNewRelation() sends.
 * The mail's own opt-out (`mentor-assigned` / `mentee-assigned`) withholds the
 * card too: the switch is about being told of the pairing, not about the
 * channel. The router renders each card in its recipient's language and
 * dedupes on the relation, so a retried announcement posts nothing twice.
 *
 * NEVER THROWS: the pairing is already committed.
 */
export async function introducePairInChat(relationId: string, mentor: Side, mentee: Side): Promise<void> {
  try {
    const capable = await chatCapableUsers([mentor.id, mentee.id]);
    if (capable.has(mentee.id) && emailGroupAllowedForCategory(mentee, 'mentor-assigned')) {
      await notifyEvent(mentee.id, 'mentorship.matched.mentee', { name: mentor.fullName, relationId }, {
        channels: ['chat'],
        dedupeKey: `pairing:${relationId}:mentee`,
        chatCard: {
          subjectKey: `pairing:${relationId}`,
          actionUrl: null,
          supersede: false,
          buttons: [{ label: 'book', actionId: 'meeting.book', value: relationId }],
        },
      });
    }
    if (capable.has(mentor.id) && emailGroupAllowedForCategory(mentor, 'mentee-assigned')) {
      const profile = await prisma.user.findUnique({ where: { id: mentee.id }, select: { skills: true } });
      await notifyEvent(mentor.id, 'mentorship.matched.mentor', { name: mentee.fullName, skills: topSkills(profile?.skills), relationId }, {
        channels: ['chat'],
        dedupeKey: `pairing:${relationId}:mentor`,
        chatCard: { subjectKey: `pairing:${relationId}`, actionUrl: null, supersede: false },
      });
    }
  } catch (e) {
    logger.warning('pairing chat DM failed', { relationId, error: String(e) });
  }
}

/** The first three skills, as the profile lists them; a dash when there are none. */
export function topSkills(skills: unknown): string {
  const list = Array.isArray(skills) ? skills.filter((s): s is string => typeof s === 'string' && s.trim() !== '') : [];
  return list.length ? list.slice(0, 3).join(', ') : '—';
}
