'use client';

// Per-stage service levels (#817).
//
// The deadline field, the overdue column and the mentor reminder all existed
// before this — but the deadline had to be typed in per candidate, so in
// practice nothing was ever overdue. This is where an organisation states the
// rule once and every stage move applies it.

import { useCallback, useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Clock } from 'lucide-react';
import { useLocale, useT } from '@/i18n/client';
import { DEFAULT_BOARD_WIP_LIMIT } from '@/lib/boardWip';
import { HolidayCalendarsEditor } from '@/components/HolidayCalendarsEditor';

interface StageRow {
  key: string;
  label: string;
  isOffPath: boolean;
  isTerminal: boolean;
  days: number | null;
  // Board WIP limit for this stage (#1439): null = inherit the org-wide
  // number, 0 = never warn about this stage.
  wipLimit: number | null;
  // The ladder's second rung (#1722): days after the breach before the org's
  // administrators are told. null = only the mentor is reminded.
  escalateAfterDays: number | null;
}

// How the days are counted (#1638).
interface DayRule {
  mode: string;
  workingDays: number[];
  holidayCalendarId: string | null;
  timeZone: string | null;
}

// ISO weekdays 1..7, labelled in the viewer's language (2026-10-19 is a Monday).
const weekdayLabel = (iso: number, locale: string) =>
  new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 9, 18 + iso)));

export function StageSlaEditor() {
  const t = useT();
  const locale = useLocale();
  const [dayRule, setDayRule] = useState<DayRule>({ mode: 'calendar', workingDays: [1, 2, 3, 4, 5], holidayCalendarId: null, timeZone: null });
  const [calendars, setCalendars] = useState<{ id: string; name: string }[]>([]);
  const [rows, setRows] = useState<StageRow[]>([]);
  // The org-wide fallback, so an empty WIP box can show what it inherits
  // instead of looking unconfigured. null = the org switched warnings off.
  const [defaultWip, setDefaultWip] = useState<number | null>(DEFAULT_BOARD_WIP_LIMIT);
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/stage-sla');
    if (res.ok) {
      const body = await res.json();
      setRows(body.stages ?? []);
      if (body.dayRule) setDayRule(body.dayRule);
      setCalendars(body.calendars ?? []);
      setDefaultWip(body.defaultWipLimit ?? null);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    setSaving(true);
    setError(null);
    setFlash(null);
    try {
      const res = await fetch('/api/admin/stage-sla', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slas: rows.map((r) => ({ stageKey: r.key, days: r.days, wipLimit: r.wipLimit, escalateAfterDays: r.escalateAfterDays })),
          dayRule,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.details?.formErrors?.[0] || body.error || 'Failed');
      setFlash(t.stageSla.saved);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setSaving(false);
    }
  };

  if (rows.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Clock className="h-5 w-5 text-blue-600" />
          <CardTitle>{t.stageSla.title}</CardTitle>
        </div>
      </CardHeader>
      <p className="text-sm text-gray-500 mb-4">{t.stageSla.subtitle}</p>
      {flash && <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm">{flash}</div>}
      {error && <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>}

      {/* Two numbers per stage since #1439 — the waiting rule and the board's
          column depth. Column headings rather than a unit label per input:
          with two boxes on a row, "Days" after the first one stopped saying
          which box it belonged to. */}
      <div className="flex items-center gap-3 text-xs text-gray-500 mb-1 px-1">
        <span className="flex-1" />
        <span className="w-16 sm:w-24">{t.stageSla.days}</span>
        <span className="w-16 sm:w-24">{t.stageSla.escalateAfter}</span>
        <span className="w-16 sm:w-24">{t.stageSla.wipLimit}</span>
      </div>
      <div className="space-y-2" data-testid="stage-sla-rows">
        {rows.map((r, i) => (
          <div key={r.key} className="flex items-center gap-3 text-sm">
            <span className="flex-1 min-w-0 truncate text-gray-700 dark:text-gray-300">
              {r.label}
              {r.isOffPath && <span className="ml-2 text-xs text-gray-400">({t.stageSla.offPath})</span>}
            </span>
            <input
              type="number"
              min={0}
              max={365}
              value={r.days ?? ''}
              placeholder={t.stageSla.noRule}
              aria-label={`${r.label} — ${t.stageSla.days}`}
              data-testid={`sla-${r.key}`}
              onChange={(e) => {
                const v = e.target.value.trim();
                const days = v === '' ? null : Number(v);
                setRows((p) => p.map((row, j) => (j === i ? { ...row, days } : row)));
              }}
              className="w-16 sm:w-24 rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-800 px-2 py-1 text-sm"
            />
            <input
              type="number"
              min={0}
              max={365}
              value={r.escalateAfterDays ?? ''}
              placeholder={t.stageSla.noRule}
              /* Escalation hangs off the service level: no days, no breach. */
              disabled={r.days == null || r.days <= 0}
              aria-label={`${r.label} — ${t.stageSla.escalateAfter}`}
              data-testid={`escalate-${r.key}`}
              onChange={(e) => {
                const v = e.target.value.trim();
                const escalateAfterDays = v === '' ? null : Number(v);
                setRows((p) => p.map((row, j) => (j === i ? { ...row, escalateAfterDays } : row)));
              }}
              className="w-16 sm:w-24 rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-800 px-2 py-1 text-sm disabled:opacity-50"
            />
            <input
              type="number"
              min={0}
              max={9999}
              value={r.wipLimit ?? ''}
              /* The placeholder is what an empty box actually does: inherit the
                 org-wide number, or nothing at all when that is switched off. */
              placeholder={
                defaultWip == null
                  ? t.stageSla.wipLimitOff
                  : t.stageSla.wipLimitDefault.replace('{n}', String(defaultWip))
              }
              aria-label={`${r.label} — ${t.stageSla.wipLimit}`}
              data-testid={`wip-${r.key}`}
              onChange={(e) => {
                const v = e.target.value.trim();
                const wipLimit = v === '' ? null : Number(v);
                setRows((p) => p.map((row, j) => (j === i ? { ...row, wipLimit } : row)));
              }}
              className="w-16 sm:w-24 rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-800 px-2 py-1 text-sm"
            />
          </div>
        ))}
      </div>

      <div className="mt-4">
        <Button size="sm" loading={saving} onClick={save} data-testid="stage-sla-save">
          {t.common.save}
        </Button>
      </div>
      {/* How the days are counted (#1638). Calendar days stay the default. */}
      <div className="mt-5 grid gap-3 sm:grid-cols-2 text-sm" data-testid="sla-day-rule">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-gray-500">{t.stageSla.dayMode}</span>
          <select
            value={dayRule.mode}
            onChange={(e) => setDayRule((r) => ({ ...r, mode: e.target.value }))}
            data-testid="sla-day-mode"
            className="rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-800 px-2 py-1"
          >
            <option value="calendar">{t.stageSla.dayModeCalendar}</option>
            <option value="business">{t.stageSla.dayModeBusiness}</option>
          </select>
        </label>
        {dayRule.mode === 'business' && (
          <>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-gray-500">{t.stageSla.holidayCalendar}</span>
              <select
                value={dayRule.holidayCalendarId ?? ''}
                onChange={(e) => setDayRule((r) => ({ ...r, holidayCalendarId: e.target.value || null }))}
                data-testid="sla-holiday-calendar"
                className="rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-800 px-2 py-1"
              >
                <option value="">{t.stageSla.noCalendar}</option>
                {calendars.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </label>
            <fieldset className="flex flex-col gap-1">
              <legend className="text-xs text-gray-500">{t.stageSla.workingDays}</legend>
              <div className="flex flex-wrap gap-2">
                {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                  <label key={d} className="flex items-center gap-1 text-xs">
                    <input
                      type="checkbox"
                      checked={dayRule.workingDays.includes(d)}
                      data-testid={`sla-workday-${d}`}
                      onChange={(e) =>
                        setDayRule((r) => ({
                          ...r,
                          workingDays: e.target.checked ? [...r.workingDays, d].sort() : r.workingDays.filter((x) => x !== d),
                        }))
                      }
                    />
                    {weekdayLabel(d, locale)}
                  </label>
                ))}
              </div>
            </fieldset>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-gray-500">{t.stageSla.timeZone}</span>
              <input
                value={dayRule.timeZone ?? ''}
                placeholder={t.stageSla.timeZoneDefault}
                maxLength={64}
                onChange={(e) => setDayRule((r) => ({ ...r, timeZone: e.target.value.trim() || null }))}
                data-testid="sla-time-zone"
                className="rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-800 px-2 py-1"
              />
            </label>
          </>
        )}
      </div>
      <p className="mt-3 text-xs text-gray-500">{t.stageSla.calendarDays}</p>
      <p className="mt-1 text-xs text-gray-500">{t.stageSla.escalateHint}</p>
      <p className="mt-1 text-xs text-gray-500">{t.stageSla.wipLimitHint}</p>
      <p className="mt-1 text-xs text-gray-500">{t.stageSla.appliesOnMove}</p>
      <HolidayCalendarsEditor onChange={load} />
    </Card>
  );
}
