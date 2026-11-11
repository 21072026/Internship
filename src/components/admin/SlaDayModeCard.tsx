'use client';

// How a stage SLA counts its days (#1638): calendar (the default, today's
// behaviour) or business days with working days, a zone and a holiday
// calendar — for the org or one programme — plus the org's holiday calendars.
// Every value is re-validated by /api/admin/sla-day-mode and
// /api/admin/holiday-calendars; this form only offers what they accept.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarDays } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { fillTemplate } from '@/components/ui/fillTemplate';
import { useLocale, useT } from '@/i18n/client';
import { addBusinessDays, DEFAULT_WORKING_DAYS } from '@/lib/businessDays';
import { formatInTimeZone, timeZoneOptions, viewerTimeZone } from '@/lib/timezone';

interface Option { id: string; name: string }
interface ModeState {
  programId: string | null;
  mode: 'calendar' | 'business';
  workingDays: number[];
  timeZone: string;
  calendarId: string;
  overridden: boolean;
  calendars: Option[];
  programs: Option[];
}
interface Calendar { id: string; name: string; holidays: { date: string; label: string }[] }

const WEEKDAYS = [
  { day: 1, key: 'mon' },
  { day: 2, key: 'tue' },
  { day: 3, key: 'wed' },
  { day: 4, key: 'thu' },
  { day: 5, key: 'fri' },
  { day: 6, key: 'sat' },
  { day: 0, key: 'sun' },
] as const;

const selectCls = 'w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1.5 text-sm';

const toText = (c: Calendar) => c.holidays.map((h) => `${h.date}, ${h.label}`).join('\n');

export function SlaDayModeCard() {
  const t = useT();
  const S = t.slaDays;
  const locale = useLocale();
  const [programId, setProgramId] = useState('');
  const [state, setState] = useState<ModeState | null>(null);
  const [calendars, setCalendars] = useState<Calendar[]>([]);
  const [drafts, setDrafts] = useState<Record<string, { name: string; text: string }>>({});
  const [busy, setBusy] = useState('');
  const [flash, setFlash] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const [mode, cals] = await Promise.all([
      fetch(`/api/admin/sla-day-mode${programId ? `?programId=${encodeURIComponent(programId)}` : ''}`),
      fetch('/api/admin/holiday-calendars'),
    ]);
    if (mode.ok) setState(await mode.json());
    if (cals.ok) {
      const list: Calendar[] = (await cals.json()).calendars ?? [];
      setCalendars(list);
      setDrafts(Object.fromEntries([...list.map((c) => [c.id, { name: c.name, text: toText(c) }]), ['new', { name: '', text: '' }]]));
    }
  }, [programId]);
  useEffect(() => { load(); }, [load]);

  const call = async (key: string, url: string, method: string, body?: unknown) => {
    setBusy(key);
    setError('');
    setFlash('');
    try {
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.code === 'invalid_lines' ? S.invalidLines.replace('{lines}', (data.invalidLines ?? []).join(', ')) : S.error);
        return false;
      }
      setFlash(S.saved);
      return true;
    } finally {
      setBusy('');
    }
  };

  // The preview runs the same pure function the server does (prisma/business-days.mjs).
  const preview = useMemo(() => {
    if (!state || state.mode !== 'business') return null;
    const zone = state.timeZone || viewerTimeZone();
    const holidays = calendars.find((c) => c.id === state.calendarId)?.holidays.map((h) => h.date) ?? [];
    try {
      const due = addBusinessDays(new Date(), 3, { workingDays: state.workingDays, holidays, timeZone: zone });
      return formatInTimeZone(due, zone, { dateStyle: 'full', timeStyle: 'short' }, locale);
    } catch {
      return null;
    }
  }, [state, calendars, locale]);

  const zones = useMemo(() => timeZoneOptions(), []);

  if (!state) return null;
  const set = (patch: Partial<ModeState>) => setState({ ...state, ...patch });
  const toggleDay = (day: number) => {
    const next = state.workingDays.includes(day) ? state.workingDays.filter((d) => d !== day) : [...state.workingDays, day];
    set({ workingDays: next.length ? next : [...DEFAULT_WORKING_DAYS] });
  };

  return (
    <Card data-testid="sla-day-mode">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CalendarDays className="h-5 w-5" />
          {S.title}
        </CardTitle>
      </CardHeader>
      <p className="mb-4 text-sm text-gray-600 dark:text-gray-300">{S.hint}</p>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="text-sm">
          <span className="mb-1 block font-medium">{S.scope}</span>
          <select className={selectCls} value={programId} onChange={(e) => setProgramId(e.target.value)} data-testid="sla-day-scope">
            <option value="">{S.scopeOrg}</option>
            {state.programs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          {programId && (
            <span className="mt-1 block text-xs text-gray-500">{state.overridden ? S.overridden : S.inheriting}</span>
          )}
        </label>
        <fieldset className="text-sm">
          <legend className="mb-1 font-medium">{S.mode}</legend>
          {(['calendar', 'business'] as const).map((m) => (
            <label key={m} className="mr-4 inline-flex items-center gap-1">
              <input type="radio" name="sla-day-mode" checked={state.mode === m} onChange={() => set({ mode: m })} data-testid={`sla-day-mode-${m}`} />
              {m === 'calendar' ? S.modeCalendar : S.modeBusiness}
            </label>
          ))}
        </fieldset>
      </div>

      {state.mode === 'business' && (
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <fieldset className="text-sm sm:col-span-2">
            <legend className="mb-1 font-medium">{S.workingDays}</legend>
            {WEEKDAYS.map((w) => (
              <label key={w.day} className="mr-3 inline-flex items-center gap-1">
                <input type="checkbox" checked={state.workingDays.includes(w.day)} onChange={() => toggleDay(w.day)} />
                {S.weekdays[w.key]}
              </label>
            ))}
          </fieldset>
          <label className="text-sm">
            <span className="mb-1 block font-medium">{S.timeZone}</span>
            <select className={selectCls} value={state.timeZone} onChange={(e) => set({ timeZone: e.target.value })}>
              <option value="">{S.timeZoneDefault}</option>
              {zones.map((z) => <option key={z.value} value={z.value}>{z.label}</option>)}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-medium">{S.calendar}</span>
            <select className={selectCls} value={state.calendarId} onChange={(e) => set({ calendarId: e.target.value })} data-testid="sla-day-calendar">
              <option value="">{S.noCalendar}</option>
              {calendars.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          {preview && <p className="text-sm text-gray-600 dark:text-gray-300 sm:col-span-2" data-testid="sla-day-preview">{fillTemplate(S.preview, { when: preview })}</p>}
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          loading={busy === 'mode'}
          data-testid="sla-day-save"
          onClick={async () => {
            if (await call('mode', '/api/admin/sla-day-mode', 'PUT', { programId: programId || null, mode: state.mode, workingDays: state.workingDays, timeZone: state.timeZone, calendarId: state.calendarId })) await load();
          }}
        >
          {S.save}
        </Button>
        {programId && state.overridden && (
          <Button
            variant="outline"
            loading={busy === 'inherit'}
            onClick={async () => {
              if (await call('inherit', `/api/admin/sla-day-mode?programId=${encodeURIComponent(programId)}`, 'DELETE')) await load();
            }}
          >
            {S.inherit}
          </Button>
        )}
      </div>

      <div className="mt-6 border-t border-gray-200 dark:border-gray-700 pt-4">
        <h3 className="font-semibold">{S.calendars}</h3>
        <p className="mb-3 text-xs text-gray-500">{S.calendarsHint}</p>
        <div className="space-y-4">
          {[...calendars.map((c) => c.id), 'new'].map((id) => {
            const draft = drafts[id] ?? { name: '', text: '' };
            const existing = calendars.find((c) => c.id === id);
            return (
              <div key={id} className="space-y-2" data-testid={`holiday-calendar-${id}`}>
                <Input
                  label={id === 'new' ? S.newCalendar : S.name}
                  value={draft.name}
                  maxLength={120}
                  onChange={(e) => setDrafts({ ...drafts, [id]: { ...draft, name: e.target.value } })}
                />
                <label className="block text-sm">
                  <span className="mb-1 block font-medium">
                    {S.holidays}
                    {existing && <span className="ml-2 text-xs font-normal text-gray-500">{fillTemplate(S.count, { n: existing.holidays.length })}</span>}
                  </span>
                  <textarea
                    className={`${selectCls} font-mono`}
                    rows={id === 'new' ? 3 : 5}
                    value={draft.text}
                    onChange={(e) => setDrafts({ ...drafts, [id]: { ...draft, text: e.target.value } })}
                    placeholder="2026-12-25, …"
                  />
                </label>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    loading={busy === `cal-${id}`}
                    disabled={!draft.name.trim()}
                    onClick={async () => {
                      const ok = id === 'new'
                        ? await call(`cal-${id}`, '/api/admin/holiday-calendars', 'POST', draft)
                        : await call(`cal-${id}`, `/api/admin/holiday-calendars/${id}`, 'PUT', draft);
                      if (ok) await load();
                    }}
                  >
                    {id === 'new' ? S.add : S.save}
                  </Button>
                  {existing && (
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={busy === `del-${id}`}
                      onClick={async () => {
                        if (await call(`del-${id}`, `/api/admin/holiday-calendars/${id}`, 'DELETE')) await load();
                      }}
                    >
                      {S.delete}
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {error && <p role="alert" className="mt-3 text-sm text-red-600">{error}</p>}
      {flash && <p role="status" className="mt-3 text-sm text-green-700 dark:text-green-400">{flash}</p>}
    </Card>
  );
}
