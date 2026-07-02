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
