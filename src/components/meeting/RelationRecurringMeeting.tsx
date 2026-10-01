'use client';

import { useCallback, useEffect, useState } from 'react';
import { CalendarClock, Video, Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useT, useLocale } from '@/i18n/client';
import { MeetingDurationSelect } from '@/components/meeting/MeetingDurationSelect';
import { meetingDurationMinutes } from '@/lib/meetingDuration';
import { MAX_INTERVAL_WEEKS, MAX_OCCURRENCES_LIMIT } from '@/lib/seriesRule';

// A standing 1:1 on a relation (#2013). Slice 1 gave MeetingSeries a relation
// context and a cadence (every N weeks, until a date or after N meetings); this
// is the control that sets one. The rule is the same MeetingSeries the project
// call uses, so the reminders, the banner, the calendar and the Google mirror
// all follow without anything here knowing about them.
//
// The relation's MENTOR (and an admin) may manage it — the API says so, not
// this component: `canManage` only decides whether the controls are drawn.

interface Series {
  id: string;
  title: string;
  daysOfWeek: number[];
  timeOfDay: string;
  timeZone: string | null;
  durationMinutes?: number | null;
  fixedLink: string | null;
  intervalWeeks: number;
  untilDate: string | null;
  maxOccurrences: number | null;
  nextOccurrence: string | null;
}

type EndMode = 'never' | 'until' | 'count';

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

interface Form {
  title: string;
  days: number[];
  timeOfDay: string;
  meetLink: string;
  durationMinutes: number;
  intervalWeeks: number;
  endMode: EndMode;
  untilDate: string;
  maxOccurrences: number;
}

export function RelationRecurringMeeting({ relationId, canManage }: { relationId: string; canManage: boolean }) {
  const t = useT();
  const S = t.oneToOneSeries;
  const locale = useLocale();
  const [series, setSeries] = useState<Series[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [stopId, setStopId] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/meeting-series?relationId=${encodeURIComponent(relationId)}`);
    if (!res.ok) { setLoading(false); return; }
    const d = await res.json();
    setSeries(
      (d.series ?? []).map((s: Series & { daysOfWeek: unknown }) => ({
        ...s,
        daysOfWeek: Array.isArray(s.daysOfWeek) ? (s.daysOfWeek as number[]).map(Number) : [],
        intervalWeeks: s.intervalWeeks ?? 1,
        nextOccurrence: s.nextOccurrence ?? null,
      }))
    );
    setLoading(false);
  }, [relationId]);

  useEffect(() => { load(); }, [load]);

  const dayLabels = (days: number[]) =>
    [...days]
      .sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))
      .map((d) => (t.projects.weekdaysShort as Record<string, string>)[DAY_KEYS[d] ?? 'mon'])
      .join(', ');

  // The rule's wall clock is its creator's; the resolved occurrence is the
  // reader's own (#1110).
  const localTime = (s: Series) =>
    s.nextOccurrence
      ? new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(s.nextOccurrence))
      : s.timeOfDay;
  const dateLabel = (iso: string, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, opts).format(new Date(iso));

  const cadenceLabel = (s: Series) => {
    const parts = [s.intervalWeeks > 1 ? S.everyNWeeks.replace('{n}', String(s.intervalWeeks)) : S.everyWeek];
    // A stored calendar date is UTC midnight; read it on UTC or it shifts a day west.
    if (s.untilDate) parts.push(S.untilLabel.replace('{date}', dateLabel(s.untilDate, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })));
    if (s.maxOccurrences) parts.push(S.countLabel.replace('{n}', String(s.maxOccurrences)));
    return parts.join(' · ');
  };

  const openForm = (s?: Series) => {
    setError('');
    setEditing(s?.id ?? null);
    setForm({
      title: s?.title ?? S.defaultTitle,
      days: s?.daysOfWeek.length ? s.daysOfWeek : [1],
      timeOfDay: s?.timeOfDay ?? '09:00',
      meetLink: s?.fixedLink ?? '',
      durationMinutes: meetingDurationMinutes(s),
      intervalWeeks: s?.intervalWeeks ?? 1,
      endMode: s?.untilDate ? 'until' : s?.maxOccurrences ? 'count' : 'never',
      untilDate: s?.untilDate ? s.untilDate.slice(0, 10) : '',
      maxOccurrences: s?.maxOccurrences ?? 10,
    });
  };

  const save = async () => {
    if (!form) return;
    if (form.days.length === 0) { setError(S.pickADay); return; }
    setSaving(true);
    setError('');
    try {
      const res = await fetch('/api/meeting-series', {
        method: editing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // The zone only on create: an existing rule keeps the clock it was set
          // up on, exactly as the project call does.
          ...(editing ? { id: editing } : { relationId, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || undefined }),
          title: form.title || S.defaultTitle,
          daysOfWeek: form.days,
          timeOfDay: form.timeOfDay,
          meetLink: form.meetLink || undefined,
          durationMinutes: form.durationMinutes,
          intervalWeeks: form.intervalWeeks,
          // Exactly one end, or none: switching the mode clears the other.
          untilDate: form.endMode === 'until' && form.untilDate ? form.untilDate : null,
          maxOccurrences: form.endMode === 'count' ? form.maxOccurrences : null,
        }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || t.common.error);
      setForm(null);
      setEditing(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t.common.error);
    } finally {
      setSaving(false);
    }
  };

  const confirmStop = async () => {
    if (!stopId || stopping) return;
    setStopping(true);
    try {
      await fetch('/api/meeting-series', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: stopId }),
      });
      await load();
    } finally {
      setStopping(false);
      setStopId(null);
    }
  };

  if (loading) return null;
  if (series.length === 0 && !canManage) return null;

  const inputCls = 'rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900';

  return (
    <>
      <div data-testid="relation-series" className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
        <h2 className="mb-1.5 flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
          <CalendarClock className="h-4 w-4 text-gray-400" /> {S.title}
        </h2>

        {series.length === 0 ? (
          <p className="text-sm text-gray-400">{S.none}</p>
        ) : (
          <ul className="space-y-2">
            {series.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-2 text-sm" data-testid={`relation-series-${s.id}`}>
                <span className="font-medium text-gray-800 dark:text-gray-200">{s.title}</span>
                <span className="text-gray-500">{dayLabels(s.daysOfWeek)} · {localTime(s)}</span>
                <span className="text-gray-500" data-testid={`relation-series-cadence-${s.id}`}>{cadenceLabel(s)}</span>
                {s.nextOccurrence && (
                  <span className="text-gray-400" data-testid={`relation-series-next-${s.id}`}>
                    {t.projects.nextOccurrence.replace('{when}', dateLabel(s.nextOccurrence, { weekday: 'short', day: 'numeric', month: 'short' }))}
                  </span>
                )}
                {s.fixedLink && (
                  <a href={s.fixedLink} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-blue-600 hover:underline">
                    <Video className="h-3.5 w-3.5" /> {t.projects.joinMeeting}
                  </a>
                )}
                {canManage && (
                  <span className="ml-auto flex gap-1">
                    <button type="button" onClick={() => openForm(s)} aria-label={t.common.edit} className="p-1 text-gray-400 hover:text-blue-600">
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button type="button" onClick={() => setStopId(s.id)} aria-label={S.stop} data-testid={`relation-series-stop-${s.id}`} className="p-1 text-gray-400 hover:text-red-600">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}

        {canManage && !form && series.length === 0 && (
          <Button type="button" size="sm" variant="outline" className="mt-2" onClick={() => openForm()} data-testid="relation-series-add">
            {S.makeRecurring}
          </Button>
        )}

        {form && (
          <div className="mt-3 max-w-md space-y-2 rounded-xl border border-gray-200 p-3 dark:border-gray-800" data-testid="relation-series-form">
            <input
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder={t.projects.meetingTitle}
              aria-label={t.projects.meetingTitle}
              className={`w-full ${inputCls}`}
            />
            <div className="flex flex-wrap gap-1">
              {DAY_KEYS.map((key, index) => {
                const on = form.days.includes(index);
                return (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setForm({ ...form, days: on ? form.days.filter((d) => d !== index) : [...form.days, index] })}
                    className={`rounded-full px-2.5 py-1 text-xs ${on ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300'}`}
                  >
                    {(t.projects.weekdaysShort as Record<string, string>)[key]}
                  </button>
                );
              })}
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
              <input
                type="time"
                value={form.timeOfDay}
                onChange={(e) => setForm({ ...form, timeOfDay: e.target.value })}
                className={`w-full sm:w-auto ${inputCls}`}
              />
              <MeetingDurationSelect
                compact
                value={form.durationMinutes}
                onChange={(n) => setForm({ ...form, durationMinutes: n })}
                className="w-full px-2.5 py-1.5 sm:w-auto"
              />
              <label className="flex min-w-0 items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
                {S.repeat}
                <select
                  value={form.intervalWeeks}
                  onChange={(e) => setForm({ ...form, intervalWeeks: Number(e.target.value) })}
                  data-testid="relation-series-interval"
                  className={`min-w-0 max-w-full ${inputCls}`}
                >
                  {Array.from({ length: MAX_INTERVAL_WEEKS }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n}>{n === 1 ? S.everyWeek : S.everyNWeeks.replace('{n}', String(n))}</option>
                  ))}
                </select>
              </label>
            </div>
            <fieldset className="space-y-1 text-sm text-gray-600 dark:text-gray-300">
              <legend className="mb-1 font-medium">{S.ends}</legend>
              {(['never', 'until', 'count'] as const).map((mode) => (
                <label key={mode} className="flex flex-wrap items-center gap-2">
                  <input
                    type="radio"
                    name={`relation-series-end-${relationId}`}
                    checked={form.endMode === mode}
                    onChange={() => setForm({ ...form, endMode: mode })}
                    data-testid={`relation-series-end-${mode}`}
                  />
                  {mode === 'never' ? S.endsNever : mode === 'until' ? S.endsOn : S.endsAfter}
                  {mode === 'until' && form.endMode === 'until' && (
                    <input
                      type="date"
                      value={form.untilDate}
                      onChange={(e) => setForm({ ...form, untilDate: e.target.value })}
                      data-testid="relation-series-until"
                      className={inputCls}
                    />
                  )}
                  {mode === 'count' && form.endMode === 'count' && (
                    <span className="flex items-center gap-1">
                      <input
                        type="number"
                        min={1}
                        max={MAX_OCCURRENCES_LIMIT}
                        value={form.maxOccurrences}
                        onChange={(e) => setForm({ ...form, maxOccurrences: Math.max(1, Math.min(MAX_OCCURRENCES_LIMIT, Number(e.target.value) || 1)) })}
                        data-testid="relation-series-count"
                        className={`w-20 ${inputCls}`}
                      />
                      {S.occurrences}
                    </span>
                  )}
                </label>
              ))}
            </fieldset>
            <input
              type="url"
              value={form.meetLink}
              onChange={(e) => setForm({ ...form, meetLink: e.target.value })}
              placeholder={t.projects.meetingLinkPlaceholder}
              className={`w-full min-w-0 ${inputCls}`}
            />
            <p className="text-xs text-gray-400">{S.reminderHint}</p>
            {error && <p className="text-xs text-red-600">{error}</p>}
            <div className="flex gap-2">
              <Button type="button" size="sm" loading={saving} onClick={save} data-testid="relation-series-save">{t.common.save}</Button>
              <Button type="button" size="sm" variant="outline" onClick={() => { setForm(null); setEditing(null); }}>{t.common.cancel}</Button>
            </div>
          </div>
        )}
      </div>
      <ConfirmDialog
        open={stopId !== null}
        message={S.confirmStop}
        cancelLabel={t.common.cancel}
        confirmLabel={S.stop}
        variant="danger"
        loading={stopping}
        onConfirm={confirmStop}
        onCancel={() => setStopId(null)}
      />
    </>
  );
}
