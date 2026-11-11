// Provider free/busy (#1997), server-only: the hours a person's REAL calendar
// says are taken, folded into busyWindows() so a caller asks one question and
// cannot tell whether the answer came from our database or from Google.
//
// THE RULES THIS FILE KEEPS
//   • Degrade, never block. No connection, a connection granted before the
//     free/busy scope existed, a timeout, a 4xx — every one of them is "no
//     provider windows" for that person, i.e. today's database-only answer. A
//     calendar API outage may not stop this product from scheduling a meeting.
//     A failure is recorded on the connection (`lastError`), never thrown.
//   • Only { start, end } crosses the boundary. freeBusy returns busy intervals
//     and nothing else, and even so the response is mapped field by field: no
//     summary, attendee or location can reach a caller, a log or a row.
//   • Never inside the booking lock. This makes HTTP calls; the write paths call
//     it BEFORE their transaction and hand the result in (busyWindows' `external`).
//   • Bounded. A hard per-request timeout (the webhook dispatcher's 5 s), at most
//     CONCURRENCY people at once, and a short in-process cache keyed by
//     (connection, window) — a scheduling screen asks for the same window again
//     and again. No durable cache.
//
// Microsoft's getSchedule joins here once its connection exists (#1991).

import { prisma } from '@/lib/prisma';
import { isGoogleCalendarEnabled } from '@/lib/googleCalendar';
import { accessTokenFor, calendarFetch, noteError } from '@/lib/googleCalendarClient';
import type { BusyWindow } from '@/lib/busyWindowsRule';

export const FREEBUSY_TIMEOUT_MS = 5_000;
const CONCURRENCY = 5;
const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 500;
// Windows are widened to the quarter hour so repeated asks share a cache entry.
const QUANTUM_MS = 15 * 60_000;

/** Scopes under which Google answers freeBusy.query. */
const FREEBUSY_SCOPES = [
  'https://www.googleapis.com/auth/calendar.freebusy',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar',
];

/** Whether a stored grant lets us ask Google for free/busy. */
export function scopeAllowsFreeBusy(scope: string | null | undefined): boolean {
  const granted = new Set((scope ?? '').split(/\s+/).filter(Boolean));
  return FREEBUSY_SCOPES.some((s) => granted.has(s));
}

const cache = new Map<string, { at: number; windows: BusyWindow[] }>();

function cached(key: string): BusyWindow[] | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.windows;
}

function remember(key: string, windows: BusyWindow[]) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(key, { at: Date.now(), windows });
}

/** Test seam: forget every cached answer. */
export function clearFreeBusyCache() {
  cache.clear();
}

async function googleBusy(userId: string, from: Date, to: Date): Promise<BusyWindow[]> {
  const auth = await accessTokenFor(userId);
  if (!auth) return [];
  const key = `${auth.connectionId}|${from.getTime()}|${to.getTime()}`;
  const hit = cached(key);
  if (hit) return hit;
  try {
    const res = await calendarFetch(auth.token, '/freeBusy', {
      method: 'POST',
      body: JSON.stringify({ timeMin: from.toISOString(), timeMax: to.toISOString(), items: [{ id: auth.calendarId }] }),
      signal: AbortSignal.timeout(FREEBUSY_TIMEOUT_MS),
    });
    if (!res.ok) {
      await noteError(auth.connectionId, `Free/busy unavailable (HTTP ${res.status})`);
      return [];
    }
    const calendars = (res.body.calendars ?? {}) as Record<string, { busy?: unknown; errors?: unknown }>;
    const entry = calendars[auth.calendarId];
    if (!entry || entry.errors) {
      await noteError(auth.connectionId, 'Free/busy unavailable for this calendar');
      return [];
    }
    // Field by field: whatever else a response carries stays here.
    const windows: BusyWindow[] = [];
    for (const b of Array.isArray(entry.busy) ? entry.busy : []) {
      const start = new Date(String((b as { start?: unknown }).start));
      const end = new Date(String((b as { end?: unknown }).end));
      if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()) && end > start) windows.push({ start, end, title: '' });
    }
    remember(key, windows);
    return windows;
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    await noteError(auth.connectionId, timedOut ? 'Free/busy timed out' : 'Free/busy request failed');
    return [];
  }
}

/**
 * The provider busy windows of each person in [from, to), by user id. People
 * without a usable, free/busy-scoped connection are simply absent.
 */
export async function providerBusy(userIds: string[], from: Date, to: Date): Promise<Map<string, BusyWindow[]>> {
  const out = new Map<string, BusyWindow[]>();
  if (!isGoogleCalendarEnabled() || userIds.length === 0 || to <= from) return out;
  const qFrom = new Date(Math.floor(from.getTime() / QUANTUM_MS) * QUANTUM_MS);
  const qTo = new Date(Math.ceil(to.getTime() / QUANTUM_MS) * QUANTUM_MS);
  const connections = await prisma.calendarConnection.findMany({
    where: { provider: 'GOOGLE', userId: { in: [...new Set(userIds)] } },
    select: { userId: true, scope: true },
  });
  const eligible = connections.filter((c) => scopeAllowsFreeBusy(c.scope)).map((c) => c.userId);
  for (let i = 0; i < eligible.length; i += CONCURRENCY) {
    const batch = eligible.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((id) => googleBusy(id, qFrom, qTo)));
    batch.forEach((id, j) => {
      if (results[j].length) out.set(id, results[j]);
    });
  }
  return out;
}
