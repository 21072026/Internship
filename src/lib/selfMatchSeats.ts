// The I/O half of the self-match limit (#1808): reads the rows
// countSelfSelected() (src/lib/mentorAvailability.ts) judges, for a set of
// mentors in two queries. Server-only (Prisma). Every self-select path — the
// directory, the preferred-mentor request and the public apply link — reads
// its counts here, so "what holds a self-selected seat" is decided once.

import { prisma } from '@/lib/prisma';
import { countSelfSelected } from '@/lib/mentorAvailability';

export async function selfSelectedCounts(mentorIds: readonly string[]): Promise<Map<string, number>> {
  const ids = [...new Set(mentorIds)];
  if (!ids.length) return new Map();
  const requests = await prisma.mentorshipRequest.findMany({
    where: { preferredMentorId: { in: ids }, status: { in: ['PENDING', 'APPROVED'] } },
    select: { menteeId: true, preferredMentorId: true, status: true },
  });
  const approvedMentees = [...new Set(requests.filter((r) => r.status === 'APPROVED').map((r) => r.menteeId))];
  const activePairs = approvedMentees.length
    ? await prisma.mentorshipRelation.findMany({
        where: { mentorId: { in: ids }, menteeId: { in: approvedMentees }, status: 'ACTIVE' },
        select: { mentorId: true, menteeId: true },
      })
    : [];
  return new Map(ids.map((id) => [id, countSelfSelected(id, requests, activePairs)]));
}

export async function selfSelectedCount(mentorId: string): Promise<number> {
  return (await selfSelectedCounts([mentorId])).get(mentorId) ?? 0;
}
