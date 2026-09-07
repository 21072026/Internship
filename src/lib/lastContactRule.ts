// "When was this mentorship last in contact?" — one rule, one implementation.
//
// The attention queue, the daily staleness reminder, the weekly mentor digest
// and the mentee cards all used to answer this from `InteractionLog` alone, and
// that is not where the contact happens any more: mentors talk to their mentees
// in the app's own messaging. A mentor who had exchanged forty messages with
// somebody last week still saw "Yakın zamanda temas yok" next to their name,
// which is how a queue of eleven rows ends up meaning nothing (#2275).
//
// So an in-app message counts as contact, with one deliberate exception:
//
//   * a 1:1 (DIRECT) message in the mentorship thread counts, in EITHER
//     direction — the mentor wrote, or the mentee answered; both are contact
//     between exactly these two people;
//   * a GROUP message counts only when the MENTEE wrote it themselves.
//
// The group rule is the whole point of the exception. A group chat is a
// broadcast: one mentor line dropped into a project channel with nine mentees
// in it is not contact with nine mentees, and treating it as such would silence
// the queue for all of them at once — the exact failure this module exists to
// fix, only inverted. A mentee posting in that same channel *is* a sign of
// life, and one the mentor should not be nagged past.
//
// Deliberately NOT included: reading a message, a reaction, a login. Those say
// somebody was present, not that the two of them spoke; the activity report
// (lib/activityReport.ts) is where presence belongs.
//
// This module is the RULE and is deliberately dependency-free (no `@/` imports,
// no Prisma types) so a plain `node --experimental-strip-types` test can import
// it — scripts/test/last-contact.test.mjs. The queries that feed it live in
// lib/lastContact.ts, which re-exports everything here.

export type ContactSource = 'interaction' | 'direct_message' | 'group_message';

export interface LastContactRelation {
  id: string;
  menteeId: string;
}

export interface LastContact {
  at: Date;
  source: ContactSource;
}

/**
 * The raw newest-timestamp-per-key rows the rule is folded from. Split out from
 * the queries so the rule itself is a pure function and can be unit-tested
 * without a database (scripts/test/last-contact.test.mjs).
 */
export interface LastContactSignals {
  /** Newest InteractionLog.date per relation id. */
  interactions: { relationId: string; at: Date }[];
  /** Newest mentorship-thread (1:1) message per relation id, either direction. */
  directMessages: { relationId: string; at: Date }[];
  /** Newest GROUP message per author, for mentees only. */
  menteeGroupPosts: { menteeId: string; at: Date }[];
}

// Latest wins. On an exact tie the more specific source is kept, which only
// affects what `source` reports — the timestamp is the same either way.
const SOURCE_RANK: Record<ContactSource, number> = {
  interaction: 3,
  direct_message: 2,
  group_message: 1,
};

export function resolveLastContacts(
  relations: LastContactRelation[],
  signals: LastContactSignals,
): Map<string, LastContact> {
  const result = new Map<string, LastContact>();
  const consider = (relationId: string, at: Date, source: ContactSource) => {
    const current = result.get(relationId);
    if (
      !current ||
      at > current.at ||
      (at.getTime() === current.at.getTime() && SOURCE_RANK[source] > SOURCE_RANK[current.source])
    ) {
      result.set(relationId, { at, source });
    }
  };

  const known = new Set(relations.map((r) => r.id));
  for (const row of signals.interactions) {
    if (known.has(row.relationId)) consider(row.relationId, row.at, 'interaction');
  }
  for (const row of signals.directMessages) {
    if (known.has(row.relationId)) consider(row.relationId, row.at, 'direct_message');
  }

  // A mentee's group post is one timestamp that applies to every mentorship
  // they are in — the sign of life is about the person, not about one pairing.
  const groupPostByMentee = new Map<string, Date>();
  for (const row of signals.menteeGroupPosts) {
    const seen = groupPostByMentee.get(row.menteeId);
    if (!seen || row.at > seen) groupPostByMentee.set(row.menteeId, row.at);
  }
  for (const relation of relations) {
    const at = groupPostByMentee.get(relation.menteeId);
    if (at) consider(relation.id, at, 'group_message');
  }

  return result;
}

/** Whole days between `at` and now — null when there is no timestamp at all. */
export function daysSince(at: Date | null | undefined, now = Date.now()): number | null {
  if (!at) return null;
  return Math.floor((now - at.getTime()) / (24 * 60 * 60 * 1000));
}
