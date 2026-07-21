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
export function formatDate(date: Date | string, locale: string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return new Intl.DateTimeFormat(locale, { year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export function formatDateTime(date: Date | string, locale: string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(d);
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
