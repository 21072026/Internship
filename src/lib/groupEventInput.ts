// Request bodies of the group-event routes (#1856). Shapes only; what is
// allowed lives in groupEventRule.ts and the seat writes in groupEvents.ts.

import { z } from 'zod';
import { EVENT_AUDIENCES, EVENT_ATTENDANCE_STATES, EVENT_LIMITS } from '@/lib/groupEventRule';

const capacity = z.number().int().min(EVENT_LIMITS.capacityMin).max(EVENT_LIMITS.capacityMax).nullable();

export const createEventSchema = z.object({
  title: z.string().trim().min(1).max(EVENT_LIMITS.titleMax),
  description: z.string().trim().max(EVENT_LIMITS.descriptionMax).optional().nullable(),
  startsAt: z.string().datetime({ offset: true }),
  timeZone: z.string().min(1).max(64),
  durationMinutes: z.number().int().min(EVENT_LIMITS.durationMin).max(EVENT_LIMITS.durationMax).default(60),
  capacity: capacity.optional().default(null),
  location: z.string().trim().max(EVENT_LIMITS.locationMax).optional().nullable(),
  // A pasted conferencing link; empty = a room of ours (resolveMeetingLink).
  joinUrl: z.string().trim().max(500).optional().nullable(),
  audience: z.enum(EVENT_AUDIENCES).default('MENTEES'),
  programId: z.string().min(1).max(64).optional().nullable(),
  // Admins may name another host of their org; a mentor always hosts their own.
  hostId: z.string().min(1).max(64).optional().nullable(),
  publish: z.boolean().optional().default(false),
});
export type CreateEventInput = z.infer<typeof createEventSchema>;

export const updateEventSchema = z.object({
  title: z.string().trim().min(1).max(EVENT_LIMITS.titleMax).optional(),
  description: z.string().trim().max(EVENT_LIMITS.descriptionMax).optional().nullable(),
  startsAt: z.string().datetime({ offset: true }).optional(),
  timeZone: z.string().min(1).max(64).optional(),
  durationMinutes: z.number().int().min(EVENT_LIMITS.durationMin).max(EVENT_LIMITS.durationMax).optional(),
  capacity: capacity.optional(),
  location: z.string().trim().max(EVENT_LIMITS.locationMax).optional().nullable(),
  joinUrl: z.string().trim().max(500).optional().nullable(),
  publish: z.literal(true).optional(),
});

export const attendanceSchema = z.object({
  userId: z.string().min(1).max(64),
  attendance: z.enum(EVENT_ATTENDANCE_STATES).nullable(),
});
