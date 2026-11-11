import { z } from 'zod';
import { TEXT_LIMITS } from '@/lib/textLimits';
import { INTERACTION_TYPES } from '@/lib/interactionTypes';

// The fields of an interaction log, as ONE shape for both doors (#1356): the
// create route and the edit route used to keep their own copies, and the edit
// copy drifted — it never learnt `subject`, and its type list stopped at Email
// until #1354. A field added here reaches both.

// A date the server can store. `new Date('garbage')` is an Invalid Date, which
// Prisma rejects with a 500; refuse it as a 400 instead.
const dateString = z
  .string()
  .min(1)
  .refine((s) => !Number.isNaN(new Date(s).getTime()), 'Invalid date');

export const interactionFieldsSchema = z.object({
  date: dateString,
  subject: z.string().max(TEXT_LIMITS.interactionSubject).optional(),
  notes: z.string().min(1, 'Notes are required').max(TEXT_LIMITS.interactionNotes),
  type: z.enum(INTERACTION_TYPES),
});

export const createInteractionSchema = interactionFieldsSchema.extend({
  relationId: z.string().min(1),
});

/** An edit names only what it changes. `subject: ''` (or null) clears it. */
export const updateInteractionSchema = interactionFieldsSchema
  .extend({ subject: z.string().max(TEXT_LIMITS.interactionSubject).nullable().optional() })
  .partial();
