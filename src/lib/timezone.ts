// Server-side date/time rendering for anything a user reads *outside* the
// browser — emails and the stored text of in-app notifications.
//
// The browser picks the viewer's zone on its own (see lib/relativeTime.ts), but
// the server has no such context: the container runs on UTC, so a plain
// `toLocaleString()` rendered a 09:00 Europe/Berlin meeting as "07:00" in the
// reminder email while the app showed 09:00 (#1030). Every server-rendered
// timestamp therefore has to name an explicit zone.
//
// Resolution order: the recipient's saved `User.timezone` → the deployment
// default (`APP_TIMEZONE`) → Europe/Istanbul.

export const FALLBACK_TIMEZONE = 'Europe/Istanbul';

export function isValidTimeZone(tz?: string | null): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Deployment-wide default for recipients who never saved a zone.
export function appTimeZone(): string {
  const configured = process.env.APP_TIMEZONE;
  return isValidTimeZone(configured) ? configured : FALLBACK_TIMEZONE;
}

export function resolveTimeZone(tz?: string | null): string {
  return isValidTimeZone(tz) ? tz : appTimeZone();
}

// "GMT+3" — appended to every rendered time so a recipient in another zone can
// see which clock the time refers to instead of guessing.
function zoneLabel(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, timeZoneName: 'shortOffset' }).formatToParts(date);
  return parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
}

// Absolute date+time in the recipient's zone, e.g. "2 Aug 2026, 09:00 (GMT+3)".
// `options` overrides the date/time style; note Intl forbids mixing
// dateStyle/timeStyle with individual component options, which is why the zone
// is appended as text rather than passed as `timeZoneName`.
export function formatInTimeZone(
  date: Date,
  tz?: string | null,
  options?: Intl.DateTimeFormatOptions
): string {
  const timeZone = resolveTimeZone(tz);
  const formatted = new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    ...options,
    timeZone,
  }).format(date);
  const label = zoneLabel(date, timeZone);
  return label ? `${formatted} (${label})` : formatted;
}
