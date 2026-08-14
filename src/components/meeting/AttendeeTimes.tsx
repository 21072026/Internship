'use client';

import { Globe } from 'lucide-react';
import { useT, useLocale } from '@/i18n/client';
import { readingsByZone, type ZonedPerson } from '@/lib/timezone';

// "What is 16:30 for the people I am inviting?" (#1210)
//
// The organizer picks a time on their own clock and the app stores an instant,
// which is correct but silent: nothing on the scheduling screen ever said what
// that instant reads as for a mentee in Istanbul or a mentor in Berlin, so the
// confirmation happened over chat, or not at all. This renders the picked
// instant on every attendee's clock, one line per distinct clock, before the
// invite goes out.
//
// Shown even when everyone is in one zone — a single line saying so is the
// confirmation, and a block that appears only sometimes teaches nobody to look
// for it.
export function AttendeeTimes({
  instantISO,
  people,
  className = '',
}: {
  /** The picked instant, ISO-8601. Empty/invalid renders nothing. */
  instantISO: string;
  people: ZonedPerson[];
  className?: string;
}) {
  const t = useT();
  const locale = useLocale();

  if (!instantISO || people.length === 0) return null;
  const at = new Date(instantISO);
  if (Number.isNaN(at.getTime())) return null;

  const readings = readingsByZone(at, people, locale);
  if (readings.length === 0) return null;

  return (
    <div
      className={`rounded-lg border border-blue-100 bg-blue-50 p-3 dark:border-blue-900 ${className}`}
      data-testid="attendee-times"
    >
      <p className="flex items-center gap-1.5 text-xs font-medium text-blue-800 dark:text-blue-300">
        <Globe className="h-3.5 w-3.5" aria-hidden="true" />
        {t.meetings.attendeeTimes}
      </p>
      <ul className="mt-2 space-y-1">
        {readings.map((r) => (
          <li key={r.timeZone} className="flex flex-wrap justify-between gap-x-3 text-xs text-blue-900 dark:text-blue-200">
            <span className="truncate">{r.names.join(', ')}</span>
            <span className="font-medium tabular-nums" title={r.timeZone}>
              {r.when} ({r.offsetLabel})
            </span>
          </li>
        ))}
      </ul>
      {readings.length === 1 && (
        <p className="mt-2 text-[11px] text-blue-700 dark:text-blue-300">{t.meetings.attendeeTimesSameZone}</p>
      )}
    </div>
  );
}
