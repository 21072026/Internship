// Group sessions and office hours (#1856) — the rules, dependency-free.
//
// Publish, register, cap, waitlist, attend. Nothing here talks to the
// database: src/lib/groupEvents.ts is the only writer and asks these
// functions what is allowed; scripts/test/group-event-rule.test.mjs pins them.
//
// Out of scope by product decision (the issue's CTO note): booths, employer
// bidding, fair sessions, room allocation, ticketing, payments, a public
// directory. Do not grow this module towards any of them.

import type { AttendanceState } from '@prisma/client';

/** Who an event is for. A programme (`programId`) narrows it further to its members. */
export const EVENT_AUDIENCES = ['MENTEES', 'MENTORS', 'ALL'] as const;
export type EventAudience = (typeof EVENT_AUDIENCES)[number];

export const REGISTRATION_STATES = ['REGISTERED', 'WAITLISTED', 'CANCELLED'] as const;
export type RegistrationState = (typeof REGISTRATION_STATES)[number];

/**
 * #2014's vocabulary, reused — never a second attendance enum. The list only
 * exists so a request body can be checked; `satisfies` breaks the build if it
 * ever names a value the Prisma enum does not have.
 */
export const EVENT_ATTENDANCE_STATES = ['ATTENDED', 'NO_SHOW', 'LATE_CANCEL', 'EXCUSED'] as const satisfies readonly AttendanceState[];

export const EVENT_LIMITS = {
  titleMax: 191,
  descriptionMax: 5000,
  locationMax: 191,
  durationMin: 5,
  durationMax: 8 * 60,
  capacityMin: 1,
  capacityMax: 1000,
} as const;

/** Attendance may be recorded from this long before the start (a host ticking people in at the door). */
export const ATTENDANCE_OPENS_BEFORE_MS = 15 * 60 * 1000;

export function isEventAudience(v: unknown): v is EventAudience {
  return typeof v === 'string' && (EVENT_AUDIENCES as readonly string[]).includes(v);
}

export function isEventAttendance(v: unknown): v is (typeof EVENT_ATTENDANCE_STATES)[number] {
  return typeof v === 'string' && (EVENT_ATTENDANCE_STATES as readonly string[]).includes(v);
}

/** Does the audience include a person of this role? Admins are staff, not audience. */
export function audienceIncludesRole(audience: string, role: string): boolean {
  if (role === 'MENTEE') return audience === 'MENTEES' || audience === 'ALL';
  if (role === 'MENTOR') return audience === 'MENTORS' || audience === 'ALL';
  return false;
}

export interface EventShape {
  startsAt: Date;
  durationMinutes: number;
  publishedAt: Date | null;
  cancelledAt: Date | null;
}

export type EventPhase = 'draft' | 'cancelled' | 'upcoming' | 'live' | 'past';

export function eventEndsAt(e: Pick<EventShape, 'startsAt' | 'durationMinutes'>): Date {
  return new Date(e.startsAt.getTime() + e.durationMinutes * 60_000);
}

export function eventPhase(e: EventShape, now: Date): EventPhase {
  if (e.cancelledAt) return 'cancelled';
  if (!e.publishedAt) return 'draft';
  if (now < e.startsAt) return 'upcoming';
  if (now < eventEndsAt(e)) return 'live';
  return 'past';
}

/** Registration is open only on a published, uncancelled event that has not started. */
export type RegistrationRefusal = 'event_draft' | 'event_cancelled' | 'event_started';

export function registrationRefusal(e: EventShape, now: Date): RegistrationRefusal | null {
  const phase = eventPhase(e, now);
  if (phase === 'draft') return 'event_draft';
  if (phase === 'cancelled') return 'event_cancelled';
  if (phase !== 'upcoming') return 'event_started';
  return null;
}

/** May the host record attendance yet? Not on a draft or a cancelled event, not long before it starts. */
export function attendanceOpen(e: EventShape, now: Date): boolean {
  if (e.cancelledAt || !e.publishedAt) return false;
  return now.getTime() >= e.startsAt.getTime() - ATTENDANCE_OPENS_BEFORE_MS;
}

/** Seats left, or null for an uncapped event. Never negative. */
export function seatsLeft(capacity: number | null, seatsTaken: number): number | null {
  if (capacity == null) return null;
  return Math.max(0, capacity - seatsTaken);
}

/** A capacity may not be set below the seats already given away — nobody is un-registered by an edit. */
export function capacityRefusal(next: number | null, seatsTaken: number): 'capacity_below_registered' | null {
  if (next != null && next < seatsTaken) return 'capacity_below_registered';
  return null;
}

export interface EventActor {
  role: string;
  userId: string;
  orgId: string | null;
}

/** Host or an admin of the event's org: edit, cancel, see the participant list, record attendance. */
export function canManageEvent(actor: EventActor, e: { hostId: string; orgId: string | null }): boolean {
  if (actor.role === 'ADMIN') return actor.orgId != null && actor.orgId === e.orgId;
  return actor.userId === e.hostId && actor.orgId === e.orgId;
}

/** Who may publish an event at all. A COMPANY or SOURCE account never hosts. */
export function canCreateEvent(role: string): boolean {
  return role === 'ADMIN' || role === 'MENTOR';
}
