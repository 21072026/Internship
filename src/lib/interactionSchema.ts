import { z } from 'zod';
import { TEXT_LIMITS } from '@/lib/textLimits';
import { INTERACTION_TYPES } from '@/lib/interactionTypes';
import { DURATION_MAX, DURATION_MIN } from '@/lib/interactionDuration';

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
  // Session length in whole minutes (#3521). Optional everywhere; never guessed.
  durationMinutes: z.number().int().min(DURATION_MIN).max(DURATION_MAX).optional(),
});

export const createInteractionSchema = interactionFieldsSchema.extend({
  relationId: z.string().min(1),
});

/** An edit names only what it changes. `subject: ''` (or null) clears it; `durationMinutes: null` clears the length. */
export const updateInteractionSchema = interactionFieldsSchema
  .extend({
    subject: z.string().max(TEXT_LIMITS.interactionSubject).nullable().optional(),
    durationMinutes: z.number().int().min(DURATION_MIN).max(DURATION_MAX).nullable().optional(),
  })
  .partial();
