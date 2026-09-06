import { resolveTimeZone, zoneLabel } from './timezone';

// Locale-aware relative time ("just now", "5 hours ago", "4 days ago"). Uses
// Intl.RelativeTimeFormat so it localizes for free. Past dates read as "… ago".
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31536000],
  ['month', 2592000],
  ['week', 604800],
  ['day', 86400],
  ['hour', 3600],
  ['minute', 60],
];

export function relativeTime(date: Date | string, locale: string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const sec = Math.round((Date.now() - d.getTime()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const abs = Math.abs(sec);
  for (const [unit, s] of UNITS) {
    if (abs >= s) return rtf.format(-Math.round(sec / s), unit);
  }
  return rtf.format(-sec, 'second'); // < 1 minute → "just now"
}

// Locale-aware absolute date/date-time formatting, so displayed dates follow
// the app's selected language (TR/DE) instead of the browser's default.
// `options` overrides the defaults below (e.g. a caller needing a long
// weekday/month form) while still resolving against the app's locale.
export function formatDate(date: Date | string, locale: string, options?: Intl.DateTimeFormatOptions): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return new Intl.DateTimeFormat(locale, { year: 'numeric', month: '2-digit', day: '2-digit', ...options }).format(d);
}

export function formatDateTime(date: Date | string, locale: string, options?: Intl.DateTimeFormatOptions): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', ...options,
  }).format(d);
}

// Time of day only ("14:32"), still on the app's locale rather than the
// browser's. `hourCycle: 'h23'` matches how the rest of the app writes times
// (the pickers, the meeting list, lib/timezone.ts § readingsByZone): a stray
// "02:32 PM" in a Turkish UI is exactly the mismatch this family exists to stop.
export function formatTime(date: Date | string, locale: string, options?: Intl.DateTimeFormatOptions): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...options }).format(d);
}

// Date + time that also NAMES its zone: "25.08.2026 16:30 (GMT+3)".
//
// A bare date-time is only unambiguous when everyone reading it shares a clock,
// and this audience does not — the mentors are in Turkey, several companies and
// mentees are in Germany. Emails already carry the zone for that reason (#1030,
// lib/timezone.ts); a proposed interview slot on screen is the same promise and
// needs the same label (#1422), otherwise an admin in Berlin books 16:30 against
// a company that meant 16:30 in Istanbul.
//
// `timeZone` is the zone to READ the instant in — pass the viewer's, resolved
// through `viewerTimeZone()` in a browser component. An absent zone resolves to
// the deployment default rather than to "whatever the runtime is set to", so the
// label is never a lie.
export function formatDateTimeWithZone(
  date: Date | string,
  locale: string,
  timeZone?: string | null,
  options?: Intl.DateTimeFormatOptions
): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const zone = resolveTimeZone(timeZone);
  const formatted = new Intl.DateTimeFormat(locale, {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    ...options,
    timeZone: zone,
  }).format(d);
  const label = zoneLabel(d, zone);
  return label ? `${formatted} (${label})` : formatted;
}

// How long ago a date is, as a positive duration ("15 days", "3 months"), for
// membership/tenure labels like "member for 3 months". Unlike relativeTime this
// returns just the magnitude — the caller supplies the surrounding phrase.
// Returns { count, unit } where unit ∈ 'day' | 'month' | 'year' so callers can
// localize the noun (day/month/year) themselves; anything under a day is a
// single day so a brand-new member never reads as "0 days".
export function durationSince(date: Date | string): { count: number; unit: 'day' | 'month' | 'year' } {
  const d = typeof date === 'string' ? new Date(date) : date;
  const days = Math.max(1, Math.floor((Date.now() - d.getTime()) / 86400000));
  if (days >= 365) return { count: Math.floor(days / 365), unit: 'year' };
  if (days >= 30) return { count: Math.floor(days / 30), unit: 'month' };
  return { count: days, unit: 'day' };
}
