'use client';

import { useCallback, useEffect, useState } from 'react';
import { CalendarCheck } from 'lucide-react';
import { useLocale, useT } from '@/i18n/client';
import { formatDate } from '@/lib/relativeTime';

// A pair's meeting rhythm (#2014): the promised interval, when they last met,
// and whether that is inside it — on the relation record, for the mentor and
// an admin, who are also the two who can set the promise. Counted, never
// predicted (src/lib/meetingCadence.ts).

interface Cadence {
  expectedIntervalWeeks: number | null;
  lastMetAt: string | null;
  daysSinceLastMet: number | null;
  onCadence: boolean | null;
}

const INTERVALS = [1, 2, 3, 4, 6, 8];

export function RelationCadencePanel({ relationId }: { relationId: string }) {
  const t = useT();
  const c = t.relationCadence;
  const locale = useLocale();
  const [data, setData] = useState<Cadence | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/mentorship/${relationId}/cadence`).catch(() => null);
    if (res?.ok) setData((await res.json()).cadence);
  }, [relationId]);

  useEffect(() => {
    load();
  }, [load]);

  if (!data) return null;

  const setInterval = async (value: string) => {
    setSaving(true);
    await fetch(`/api/mentorship/${relationId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedMeetingIntervalWeeks: value ? Number(value) : null }),
    }).catch(() => null);
    setSaving(false);
    await load();
  };

  const status =
    data.onCadence === null
      ? c.noPromise
      : data.onCadence
        ? c.onCadence
        : data.lastMetAt
          ? c.offCadence
          : c.neverMet;
  const tone = data.onCadence === false ? 'text-amber-700 dark:text-amber-400' : data.onCadence ? 'text-green-700 dark:text-green-400' : 'text-gray-600 dark:text-gray-300';

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900" data-testid="relation-cadence">
      <div className="flex flex-wrap items-center gap-3">
        <CalendarCheck className="h-5 w-5 text-green-600" />
        <p className="font-medium text-gray-900 dark:text-gray-100">{c.title}</p>
        <span className={`text-sm font-medium ${tone}`} data-testid="relation-cadence-status">{status}</span>
        <label className="ml-auto flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
          {c.promise}
          <select
            value={data.expectedIntervalWeeks ?? ''}
            disabled={saving}
            onChange={(e) => setInterval(e.target.value)}
            data-testid="relation-cadence-interval"
            className="min-h-[36px] rounded-lg border border-gray-300 px-2 text-sm dark:border-gray-700 dark:bg-gray-800"
          >
            <option value="">{c.none}</option>
            {INTERVALS.map((w) => (
              <option key={w} value={w}>{(w === 1 ? c.everyWeek : c.everyWeeks).replace('{n}', String(w))}</option>
            ))}
          </select>
        </label>
      </div>
      <p className="mt-1 text-sm text-gray-500" data-testid="relation-cadence-last">
        {data.lastMetAt ? c.lastMet.replace('{date}', formatDate(data.lastMetAt, locale)).replace('{n}', String(data.daysSinceLastMet ?? 0)) : c.noMeetingYet}
      </p>
    </div>
  );
}
