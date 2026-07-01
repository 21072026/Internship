import { prisma } from '@/lib/prisma';
import { getSetting } from '@/lib/settings';

export type AttentionReason = 'inactive' | 'overdue' | 'unanswered_question' | 'pending_meeting';

export interface AttentionItem {
  relationId: string;
  menteeId: string;
  menteeName: string;
  reasons: AttentionReason[];
  daysSinceLastInteraction: number | null;
}

// A ranked "needs attention" list for a mentor's active mentees (EPIC: mentor
// attention queue). Reuses the same inactivity threshold as the weekly email
// digest (Setting.reminderDays, default 14) so the in-app view and the email
// agree on what "stale" means.
export async function getAttentionItems(mentorId: string): Promise<AttentionItem[]> {
  const reminderDays = parseInt(await getSetting('reminderDays'), 10) || 14;
  const now = Date.now();
  const staleCutoff = new Date(now - reminderDays * 24 * 60 * 60 * 1000);

  const relations = await prisma.mentorshipRelation.findMany({
    where: { mentorId, status: 'ACTIVE' },
    select: {
      id: true,
      stageDeadline: true,
      mentee: { select: { id: true, fullName: true } },
      interactions: { orderBy: { date: 'desc' }, take: 1, select: { date: true } },
      questions: { where: { answer: null }, select: { id: true } },
      meetingRequests: { where: { status: 'PENDING' }, select: { id: true } },
    },
  });

  const items: AttentionItem[] = [];
  for (const r of relations) {
    const reasons: AttentionReason[] = [];
    const last = r.interactions[0]?.date ?? null;
    const daysSince = last ? Math.floor((now - last.getTime()) / (24 * 60 * 60 * 1000)) : null;

    if (!last || last < staleCutoff) reasons.push('inactive');
    if (r.stageDeadline && r.stageDeadline.getTime() < now) reasons.push('overdue');
    if (r.questions.length > 0) reasons.push('unanswered_question');
    if (r.meetingRequests.length > 0) reasons.push('pending_meeting');

    if (reasons.length > 0) {
      items.push({
        relationId: r.id,
        menteeId: r.mentee.id,
        menteeName: r.mentee.fullName,
        reasons,
        daysSinceLastInteraction: daysSince,
      });
    }
  }

  // Most reasons first, then longest-inactive first.
  items.sort((a, b) => {
    if (b.reasons.length !== a.reasons.length) return b.reasons.length - a.reasons.length;
    return (b.daysSinceLastInteraction ?? Infinity) - (a.daysSinceLastInteraction ?? Infinity);
  });

  return items;
}
