import { z } from 'zod';
import { TEXT_LIMITS } from '@/lib/textLimits';
import { INTERACTION_TYPES } from '@/lib/interactionTypes';
import { isDayOnly } from '@/lib/relativeTime';

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

/**
 * The stored instant of a log's `date` (#3901). Two shapes arrive: a calendar
 * day (`2026-11-24`, what the older forms and imports send) and an instant
 * (the log form's date + time, sent as ISO). The app reads "a day, no time"
 * from the value itself — exactly UTC midnight (`isDayOnly`, the convention the
 * lists already use) — so a day is stored as that midnight and shown without an
 * invented "01:00", while an instant that happens to land on UTC midnight to
 * the millisecond (01:00 in Berlin in winter, typed on the minute) is moved by
 * one millisecond so it keeps its time of day. No column, no backfill: every
 * row written before the form learnt the time is already a UTC midnight.
 */
export function interactionInstant(input: string): Date {
  const d = new Date(input);
  if (/^\d{4}-\d{2}-\d{2}$/.test(input.trim())) return d;
  return isDayOnly(d) ? new Date(d.getTime() + 1) : d;
}
