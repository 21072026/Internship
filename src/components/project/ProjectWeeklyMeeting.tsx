'use client';

import { useCallback, useEffect, useState } from 'react';
import { CalendarClock, Video, Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useT, useLocale } from '@/i18n/client';
import { StartMeetingButton } from '@/components/meeting/StartMeetingButton';

// The project's recurring meeting (#51).
//
// MeetingSeries and its API have existed since #774, but nothing ever rendered
// them: there was no field anywhere that said "this project's weekly call is
// Mon+Thu at 09:30, here is the link". Members read it here; owners and mentor
// members set it here. Reminders are handled server-side (emailService), honoring
// each member's notification preferences.

interface Series {
  id: string;
  title: string;
  daysOfWeek: number[];
  timeOfDay: string;
  /** IANA zone the rule's wall clock is on; null = the deployment default. */
  timeZone: string | null;
  fixedLink: string | null;
  /** Resolved by the server from the rule — the actual instant of the next call. */
  nextOccurrence: string | null;
}

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

export function ProjectWeeklyMeeting({
  projectId,
  canManage,
  canStartInstant = false,
  projectName,
}: {
  projectId: string;
  canManage: boolean;
  // Separate from canManage: editing the weekly rule and starting an ad-hoc call
  // are different permissions (MENTOR members get the second, not the first).
  canStartInstant?: boolean;
  projectName?: string;
}) {
  const t = useT();
  const locale = useLocale();
  const [series, setSeries] = useState<Series[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ title: '', days: [1] as number[], timeOfDay: '09:00', meetLink: '' });

  const load = useCallback(async () => {
    const res = await fetch(`/api/meeting-series?projectId=${projectId}`);
    if (!res.ok) { setLoading(false); return; }
    const d = await res.json();
    setSeries(
      (d.series ?? []).map((s: Series & { daysOfWeek: unknown }) => ({
        ...s,
        daysOfWeek: Array.isArray(s.daysOfWeek) ? (s.daysOfWeek as number[]).map(Number) : [],
        nextOccurrence: s.nextOccurrence ?? null,
      }))
    );
    setLoading(false);
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  // The rule's `timeOfDay` is on the clock of whoever set it up. Rendering the
  // resolved occurrence instead means a reader in another zone sees the time
  // they have to show up at, not the organizer's (#1110).
  const localTime = (s: Series) =>
    s.nextOccurrence
      // `h23`: the app writes times as "18:30" everywhere (the rule itself, the
      // time input), so the rendered occurrence must not flip to "06:30 PM".
      ? new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(s.nextOccurrence))
      : s.timeOfDay;

  const nextLabel = (iso: string) =>
    new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(iso));

  const dayLabels = (days: number[]) =>
    [...days]
      .sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))
      .map((d) => (t.projects.weekdaysShort as Record<string, string>)[DAY_KEYS[d] ?? 'mon'])
      .join(', ');

  const openForm = (s?: Series) => {
    setError('');
    setEditing(s?.id ?? null);
    setForm({
      title: s?.title ?? t.projects.weeklyMeetingDefaultTitle,
      days: s?.daysOfWeek.length ? s.daysOfWeek : [1],
      timeOfDay: s?.timeOfDay ?? '09:00',
      meetLink: s?.fixedLink ?? '',
    });
    setShowForm(true);
  };

  const save = async () => {
    if (form.days.length === 0) { setError(t.projects.pickADay); return; }
    setSaving(true);
    setError('');
    try {
      const res = await fetch('/api/meeting-series', {
        method: editing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // The time is picked on *this* clock. Without saying which one, the
          // server anchored it to UTC and reminded a 09:00 call as 12:00 (#1110).
          // Only on create, though: an existing rule keeps the zone it was set
          // up on, so editing it from another country doesn't silently move the
          // meeting for everyone else.
          ...(editing ? { id: editing } : { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || undefined }),
          projectId,
          title: form.title,
          daysOfWeek: form.days,
          timeOfDay: form.timeOfDay,
          meetLink: form.meetLink || undefined,
        }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || t.common.error);
      setShowForm(false);
      setEditing(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t.common.error);
    } finally {
      setSaving(false);
    }
  };

  const stop = async (id: string) => {
    if (!window.confirm(t.projects.confirmStopMeeting)) return;
    await fetch('/api/meeting-series', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    await load();
  };

  if (loading) return null;
  // `|| canStartInstant`: a MENTOR member who may summon the team but can't edit
  // the schedule still needs somewhere to press the button (#1055).
  if (series.length === 0 && !canManage && !canStartInstant) return null;

  return (
    <div data-testid="weekly-meeting">
      <h2 className="mb-1.5 flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
        <CalendarClock className="h-4 w-4 text-gray-400" /> {t.projects.weeklyMeeting}
        {/* The recurring rule and an ad-hoc "everyone, now" call are separate
            things; they just live next to each other. */}
        {canStartInstant && (
          <StartMeetingButton
            className="ml-auto"
            target={{ projectId }}
            defaultTitle={projectName}
            testId="start-meeting-project"
          />
        )}
      </h2>

      {series.length === 0 ? (
        <p className="text-sm text-gray-400">{t.projects.noWeeklyMeeting}</p>
      ) : (
        <ul className="space-y-2">
          {series.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-2 text-sm" data-testid={`series-${s.id}`}>
              <span className="font-medium text-gray-800 dark:text-gray-200">{s.title}</span>
              <span className="text-gray-500">
                {dayLabels(s.daysOfWeek)} · {localTime(s)}
              </span>
              {/* The rule reads as a puzzle on its own ("Mon, Thu · 09:00" —
                  is that today?); the resolved next occurrence answers it, in
                  the reader's own zone. */}
              {s.nextOccurrence && (
                <span className="text-gray-400" data-testid={`series-next-${s.id}`}>
                  {t.projects.nextOccurrence.replace('{when}', nextLabel(s.nextOccurrence))}
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
                  <button type="button" onClick={() => stop(s.id)} aria-label={t.projects.stopMeeting} className="p-1 text-gray-400 hover:text-red-600">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {canManage && !showForm && (
        <Button type="button" size="sm" variant="outline" className="mt-2" onClick={() => openForm()} data-testid="add-weekly-meeting">
          {series.length === 0 ? t.projects.setWeeklyMeeting : t.projects.addAnotherMeeting}
        </Button>
      )}

      {showForm && (
        <div className="mt-3 max-w-md space-y-2 rounded-xl border border-gray-200 p-3 dark:border-gray-800">
          <input
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            placeholder={t.projects.meetingTitle}
            className="w-full rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900"
          />
          <div className="flex flex-wrap gap-1">
            {DAY_KEYS.map((key, index) => {
              const on = form.days.includes(index);
              return (
                <button
                  key={key}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    setForm({
                      ...form,
                      days: on ? form.days.filter((d) => d !== index) : [...form.days, index],
                    })
                  }
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
              className="w-full rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900 sm:w-auto"
            />
            <input
              type="url"
              value={form.meetLink}
              onChange={(e) => setForm({ ...form, meetLink: e.target.value })}
              placeholder={t.projects.meetingLinkPlaceholder}
              className="w-full min-w-0 rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900 sm:flex-1"
            />
          </div>
          <p className="text-xs text-gray-400">{t.projects.meetingLinkHint}</p>
          {error && <p className="text-xs text-red-600">{error}</p>}
          <div className="flex gap-2">
            <Button type="button" size="sm" loading={saving} onClick={save} data-testid="save-weekly-meeting">{t.projects.save}</Button>
            <Button type="button" size="sm" variant="outline" onClick={() => { setShowForm(false); setEditing(null); }}>{t.common.cancel}</Button>
          </div>
        </div>
      )}
    </div>
  );
}
