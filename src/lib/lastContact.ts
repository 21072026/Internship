// The database half of the "when was this mentorship last in contact?" rule.
// The rule itself — and the reasoning behind it — is in lib/lastContactRule.ts,
// which is dependency-free so it can be unit-tested; everything it exports is
// re-exported here so call sites need only one import.

import { prisma } from '@/lib/prisma';
import { resolveLastContacts, type LastContact, type LastContactRelation } from '@/lib/lastContactRule';

export * from '@/lib/lastContactRule';

/**
 * Read the signals for the given relations and fold them into one
 * relationId → last contact map. Three grouped aggregates regardless of how
 * many relations are passed, so the daily cron (every active relation) and a
 * single mentor's dashboard cost the same number of round trips.
 */
export async function getLastContacts(
  relations: LastContactRelation[],
): Promise<Map<string, LastContact>> {
  if (relations.length === 0) return new Map();

  const relationIds = relations.map((r) => r.id);
  const menteeIds = [...new Set(relations.map((r) => r.menteeId))];

  const [interactions, directMessages, menteeGroupPosts] = await Promise.all([
    prisma.interactionLog.groupBy({
      by: ['relationId'],
      where: { relationId: { in: relationIds } },
      _max: { date: true },
    }),
    prisma.message.groupBy({
      by: ['relationId'],
      where: {
        relationId: { in: relationIds },
        // A relation-stamped message is written into the pair's DIRECT
        // conversation (or, for rows predating the conversation layer, into no
        // conversation at all) — see lib/conversations.ts. The filter is
        // belt-and-braces: it keeps the "groups don't count" half of the rule
        // true by construction rather than by trusting the write path.
        OR: [{ conversationId: null }, { conversation: { type: 'DIRECT' } }],
      },
      _max: { createdAt: true },
    }),
    prisma.message.groupBy({
      by: ['senderId'],
      where: { senderId: { in: menteeIds }, conversation: { type: 'GROUP' } },
      _max: { createdAt: true },
    }),
  ]);

  return resolveLastContacts(relations, {
    interactions: interactions.flatMap((row) =>
      row.relationId && row._max.date ? [{ relationId: row.relationId, at: row._max.date }] : [],
    ),
    directMessages: directMessages.flatMap((row) =>
      row.relationId && row._max.createdAt
        ? [{ relationId: row.relationId, at: row._max.createdAt }]
        : [],
    ),
    menteeGroupPosts: menteeGroupPosts.flatMap((row) =>
      row._max.createdAt ? [{ menteeId: row.senderId, at: row._max.createdAt }] : [],
    ),
  });
}
