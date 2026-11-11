import type { CalendarProviderKind } from '@prisma/client';
import { isGoogleCalendarEnabled } from '@/lib/googleCalendar';
import { googleSyncProvider } from '@/lib/calendar/google';
import { isMicrosoftCalendarEnabled } from '@/lib/microsoftCalendar';
import { microsoftSyncProvider } from '@/lib/calendar/microsoft';
import type { PushableMeeting } from '@/lib/calendar/pushable';

/**
 * One calendar provider, as the meeting sync sees it (#1989/#1991). The sync
 * loop in src/lib/googleCalendarSync.ts (pushMeeting / removeMeeting) talks
 * only to this interface, so a meeting reaches every calendar a person has
 * connected — Google, Microsoft, or both — through one create-or-patch,
 * dead-pointer-cleanup and record-the-error policy.
 *
 * SERVER ONLY. The connect/consent half stays per provider (its routes under
 * /api/integrations/<provider>/), and the status card reads the separate
 * registry in src/lib/calendarProviders.ts.
 */
export interface CalendarAuth {
  token: string;
  connectionId: string;
  calendarId: string;
}

export interface CalendarWriteResult {
  ok: boolean;
  status: number;
  /** The provider's id for the event, on a successful create or update. */
  eventId?: string;
}

/** The slot a conference room is generated for (#2009). */
export interface ConferenceSlot {
  title: string;
  start: Date;
  end: Date;
  timeZone: string | null;
}

export interface ConferenceResult extends CalendarWriteResult {
  /** The join URL the provider created (Meet `hangoutLink`, Teams `onlineMeeting.joinUrl`). */
  joinUrl?: string;
}

export interface CalendarSyncProvider {
  kind: CalendarProviderKind;
  /** Configured AND switched on by the operator. */
  isEnabled(): boolean;
  /** A usable token for this person's connection to this provider, or null. */
  accessTokenFor(userId: string): Promise<CalendarAuth | null>;
  /** Record a failure on the connection; never throws. */
  noteError(connectionId: string, message: string): Promise<void>;
  /** Create (`existingEventId` null) or update the event. Never throws on HTTP errors. */
  writeEvent(auth: CalendarAuth, meeting: PushableMeeting, product: string, existingEventId: string | null): Promise<CalendarWriteResult>;
  /** Delete the event; best effort. */
  deleteEvent(auth: CalendarAuth, calendarId: string, eventId: string): Promise<void>;
  /**
   * Create the event WITH a conference room of the provider's own (#2009):
   * Google Meet, Microsoft Teams. Never throws on HTTP errors.
   */
  createConference(auth: CalendarAuth, slot: ConferenceSlot): Promise<ConferenceResult>;
}

export const CALENDAR_SYNC_PROVIDERS: readonly CalendarSyncProvider[] = [googleSyncProvider, microsoftSyncProvider];

/** The providers switched on in this deployment. */
export function enabledSyncProviders(): CalendarSyncProvider[] {
  return CALENDAR_SYNC_PROVIDERS.filter((p) => p.isEnabled());
}

/** Whether any meeting mirroring can happen at all — the cheap early exit. */
export function anyCalendarSyncEnabled(): boolean {
  return isGoogleCalendarEnabled() || isMicrosoftCalendarEnabled();
}
