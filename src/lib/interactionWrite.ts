import type { InteractionType } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { shellCapabilities } from '@/lib/shellCapabilities';
import { emit } from '@/lib/events/emit';
import { recordPairActivity } from '@/lib/metering';
import { notifyIfAllowed } from '@/lib/notify';

// Logging an interaction, as ONE write path (#1996): the row, the metering
// signal, the `interaction.logged` webhook and the mentee's bell. It is what
// POST /api/interactions did inline; it was extracted so the public API
// (POST /api/v1/interactions) logs the same thing with the same effects rather
// than a fork that forgets one — exactly one `interaction.logged` per row,
// whichever door it came through.
//
// Authorization and tenant scoping stay with the caller: by the time this runs
// the caller has established that `relation` is one it may log against.
export async function createInteraction(opts: {
  relation: { id: string; orgId: string | null; menteeId: string };
  date: Date;
  type: InteractionType;
  notes: string;
  subject?: string | null;
  /** The person logging it, or null for a machine (an API key) — never the mentee's own echo. */
  actorId: string | null;
}) {
  const { relation } = opts;
  const interaction = await prisma.interactionLog.create({
    data: {
      relationId: relation.id,
      date: opts.date,
      subject: opts.subject || null,
      notes: opts.notes,
      type: opts.type,
    },
  });

  // Metering signal (#1750): activity VOLUME, not the pair count — one pair
  // logging fifty interactions is still one billable pair. Collected here so
  // the nightly rollup can eventually read a stream instead of scanning seven
  // domain tables; until then activeMatchedPairs() is the truth. Never
  // awaited, and it cannot fail the write.
  recordPairActivity(relation.orgId);

  await emit('interaction.logged', { relationId: relation.id, type: opts.type, date: interaction.date.toISOString() }, {
    orgId: relation.orgId ?? null,
    actor: opts.actorId ? { id: opts.actorId, type: 'user' } : { type: 'apikey' },
  });
  // The mentee learns something was logged (#924). No echo: the mentee logging
  // on their own relation is not told about it. The notification carries no
  // note content, just the fact.
  // Mentorship only: in a vertical without the module (MARKETING, #2580) the
  // MENTEE row is the lead on a sales record, not someone with a portal to
  // read a "your mentor logged something" bell in.
  if (relation.menteeId !== opts.actorId && (await shellCapabilities(relation.orgId)).includes('mentorship')) {
    await notifyIfAllowed(relation.menteeId, 'interactions', 'interaction.logged', {}, '/portal/journey');
  }
  return interaction;
}
