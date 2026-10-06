'use client';

import { useEffect, useState } from 'react';
import { UserCheck } from 'lucide-react';
import { useT } from '@/i18n/client';

// "Who was there?" — the step right after a pair's meeting is marked as ended
// (#2014). Everyone defaults to attended, so the common case is one tap;
// marking the exception is one more. Skipping records nothing, which the
// cadence figures read as "everyone came" (src/lib/meetingCadence.ts).
// A meeting that is not a pair's (a project room) answers 400/404 and the
// step simply does not appear.

type State = 'ATTENDED' | 'NO_SHOW' | 'EXCUSED';
interface Participant { id: string; name: string; role: 'MENTOR' | 'MENTEE' }

export function AttendanceStep({ meetingId, onDone }: { meetingId: string; onDone: () => void }) {
  const t = useT();
  const a = t.attendanceStep;
  const [people, setPeople] = useState<Participant[] | null>(null);
  const [states, setStates] = useState<Record<string, State>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/meetings/${encodeURIComponent(meetingId)}/attendance`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((body) => {
        if (cancelled) return;
        setPeople(body.participants);
        const recorded = Object.fromEntries((body.attendance as { userId: string; state: State }[]).map((row) => [row.userId, row.state]));
        setStates(Object.fromEntries((body.participants as Participant[]).map((p) => [p.id, recorded[p.id] ?? 'ATTENDED'])));
      })
      .catch(() => {
        // Not a pair's meeting, or not ours to record: nothing to ask.
        if (!cancelled) onDone();
      });
    return () => {
      cancelled = true;
    };
  }, [meetingId, onDone]);

  if (!people) return null;

  const save = async () => {
    setSaving(true);
    setError('');
    const res = await fetch(`/api/meetings/${encodeURIComponent(meetingId)}/attendance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries: people.map((p) => ({ userId: p.id, state: states[p.id] ?? 'ATTENDED' })) }),
    }).catch(() => null);
    setSaving(false);
    if (res?.ok) onDone();
    else setError(t.common.error);
  };

  const options: { value: State; label: string }[] = [
    { value: 'ATTENDED', label: a.attended },
    { value: 'NO_SHOW', label: a.noShow },
    { value: 'EXCUSED', label: a.excused },
  ];

  return (
    <div className="mb-6 rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900" data-testid="attendance-step">
      <p className="flex items-center gap-2 font-medium text-gray-900 dark:text-gray-100">
        <UserCheck className="h-5 w-5 text-green-600" /> {a.title}
      </p>
      <p className="mt-1 text-sm text-gray-500">{a.subtitle}</p>
      <ul className="mt-3 space-y-2">
        {people.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center gap-2" data-testid={`attendance-row-${p.id}`}>
            <span className="min-w-0 flex-1 truncate text-sm text-gray-800 dark:text-gray-200">{p.name}</span>
            <div className="flex gap-1" role="radiogroup" aria-label={p.name}>
              {options.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  role="radio"
                  aria-checked={states[p.id] === o.value}
                  onClick={() => setStates((prev) => ({ ...prev, [p.id]: o.value }))}
                  data-testid={`attendance-${p.id}-${o.value}`}
                  className={`min-h-[36px] rounded-lg border px-2.5 text-sm ${
                    states[p.id] === o.value
                      ? 'border-blue-600 bg-blue-600 text-white'
                      : 'border-gray-200 text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800'
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" onClick={save} disabled={saving} data-testid="attendance-save" className="min-h-[36px] rounded-lg bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
          {a.save}
        </button>
        <button type="button" onClick={onDone} data-testid="attendance-skip" className="min-h-[36px] rounded-lg px-3 text-sm text-gray-600 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-800">
          {a.skip}
        </button>
        {error && <span className="text-sm text-red-600" role="alert">{error}</span>}
      </div>
    </div>
  );
}
