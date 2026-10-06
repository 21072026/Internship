'use client';

import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { useT, useLocale } from '@/i18n/client';
import { AttendeeTimes } from '@/components/meeting/AttendeeTimes';
import type { ZonedPerson } from '@/lib/timezone';

// "Suggested times" (#1999): a strip of chips above the date picker. Each chip
// is on the viewer's own clock; the picked one expands into AttendeeTimes, so
// what it reads as for everyone is visible before it is chosen. Picking only
// fills the form — the booking goes through the screen's existing POST, with
// the conflict guard and the booking rules still applying there.

interface Payload {
  suggestions: { startISO: string; endISO: string }[];
  reason: string | null;
  people: ZonedPerson[];
}

export function SuggestedTimes({ relationId, onPick, count = 5 }: { relationId: string; onPick: (startISO: string) => void; count?: number }) {
  const t = useT();
  const s = t.meetings.suggest;
  const locale = useLocale();
  const [data, setData] = useState<Payload | null>(null);
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    fetch(`/api/meetings/suggested-times?${new URLSearchParams({ relationId, count: String(count) })}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled) setData(d); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [relationId, count]);

  // Nothing to say when the read failed: the form below works without it.
  if (data === null) return <p className="text-xs text-gray-400 mb-3" data-testid="suggested-times-loading">{s.loading}</p>;
  const label = (iso: string) =>
    new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));

  return (
    <div className="mb-4" data-testid="suggested-times">
      <p className="flex items-center gap-1.5 text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
        <Sparkles className="h-3.5 w-3.5" aria-hidden /> {s.title}
      </p>
      {data.suggestions.length === 0 ? (
        <p className="text-xs text-gray-500 dark:text-gray-400" data-testid="suggested-times-empty">
          {(s.reasons as Record<string, string>)[data.reason ?? ''] ?? s.reasons.all_taken}
        </p>
      ) : (
        <>
          <p className="text-[11px] text-gray-500 dark:text-gray-400 mb-1.5">{s.hint}</p>
          <div className="flex flex-wrap gap-1.5">
            {data.suggestions.map((x) => (
              <button
                key={x.startISO}
                type="button"
                data-testid="suggested-time"
                aria-pressed={picked === x.startISO}
                onClick={() => { setPicked(x.startISO); onPick(x.startISO); }}
                className={`rounded-full border px-3 py-1 text-xs tabular-nums ${
                  picked === x.startISO
                    ? 'border-blue-600 bg-blue-600 text-white'
                    : 'border-gray-300 text-gray-700 hover:border-blue-400 dark:border-gray-600 dark:text-gray-200'
                }`}
              >
                {label(x.startISO)}
              </button>
            ))}
          </div>
          {picked && <AttendeeTimes instantISO={picked} people={data.people} className="mt-2" />}
        </>
      )}
    </div>
  );
}
