import type { InteractionType } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { inCallerTenant } from '@/lib/tenantFilter';
import type { z } from 'zod';
import type { updateInteractionSchema } from '@/lib/interactionSchema';
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

/**
 * Who may edit or delete a log (#1953): the relation's mentor, or an admin the
 * permission rule lets write relations. One answer for PUT/DELETE
 * /api/interactions/[id] and the chat "Add notes" card. A log on another
 * tenant's relation reads as missing — 404, never 403, so the id is not
 * confirmed to exist (#2542); InteractionLog has no orgId of its own, its
 * tenant is its relation's.
 */
export async function interactionAccess(id: string, userId: string, isAdmin: boolean, callerOrgId: string | null) {
  const interaction = await prisma.interactionLog.findUnique({
    where: { id },
    include: { relation: true },
  });
  if (!interaction) return { interaction: null, authorized: false };
  if (!(await inCallerTenant(interaction.relation.orgId, callerOrgId))) {
    return { interaction: null, authorized: false };
  }
  return { interaction, authorized: isAdmin || interaction.relation.mentorId === userId };
}

/**
 * Edit a log, as ONE write path (#1953): the edit route and the chat card
 * both call this after interactionAccess() said yes. The same fields the
 * create route takes (src/lib/interactionSchema.ts, #1356), so a Call keeps
 * its type and a subject can be corrected. An emptied subject is stored as
 * NULL, as the create path stores a missing one.
 */
export async function updateInteraction(id: string, data: z.infer<typeof updateInteractionSchema>) {
  const { date, subject, ...rest } = data;
  return prisma.interactionLog.update({
    where: { id },
    data: {
      ...rest,
      ...(date !== undefined ? { date: new Date(date) } : {}),
      ...(subject !== undefined ? { subject: subject?.trim() ? subject.trim() : null } : {}),
    },
  });
}
