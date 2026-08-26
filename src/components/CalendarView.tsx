'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Video, Flag, CheckCircle2, Repeat } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { useT, useLocale } from '@/i18n/client';

// The calendar (#1110).
//
// It used to be a month grid and nothing else, which on a phone meant 30 cells
// roughly a thumbnail wide each — unreadable, and the reason the agenda view
// exists. Four views now share one data fetch and one event renderer:
//
//   month  — the overview; a tapped day opens its own list underneath
//   week   — seven day columns (a stacked list on a phone)
//   day    — one day, in full
//   agenda — "what's coming up", a flat chronological list. Default on phones.
//
// Only the visible range is fetched, so a recurring project meeting can be
// expanded from its rule for whatever window is on screen instead of being
// materialised into rows in the database.

export type CalendarViewMode = 'month' | 'week' | 'day' | 'agenda';

interface Ev {
  id: string;
  type: 'meeting' | 'series' | 'deadline' | 'logged';
  title: string;
  who: string;
  date: string;
  overdue?: boolean;
  link?: string | null;
}

const VIEWS: CalendarViewMode[] = ['month', 'week', 'day', 'agenda'];
const VIEW_STORAGE_KEY = 'crm.calendar.view';
/** How far ahead the agenda looks. */
const AGENDA_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const dayKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
};
/** Monday-first week start, matching the grid's weekday header. */
const startOfWeek = (d: Date) => addDays(startOfDay(d), -((d.getDay() + 6) % 7));

const CHIP: Record<Ev['type'], string> = {
  meeting: 'bg-blue-100 text-blue-700',
  series: 'bg-indigo-100 text-indigo-700',
  logged: 'bg-emerald-100 text-emerald-700',
  deadline: 'bg-amber-100 text-amber-700',
};
const DOT: Record<Ev['type'], string> = {
  meeting: 'bg-blue-500',
  series: 'bg-indigo-500',
  logged: 'bg-emerald-500',
  deadline: 'bg-amber-500',
};

function EventIcon({ type }: { type: Ev['type'] }) {
  const cls = 'h-3 w-3 flex-shrink-0';
  if (type === 'deadline') return <Flag className={cls} />;
  if (type === 'logged') return <CheckCircle2 className={cls} />;
  if (type === 'series') return <Repeat className={cls} />;
  return <Video className={cls} />;
}

/**
 * What to put on the chip. A recurring project meeting is one event for the
 * whole team, so it is named by its own title with the project as context — it
 * used to be rendered once per mentee, under the mentee's name (#1110).
 */
function primaryLabel(e: Ev) {
  return e.type === 'series' ? e.title : e.who;
}
function secondaryLabel(e: Ev) {
  return e.type === 'series' ? e.who : e.title;
}

export function CalendarView({ initialView }: { initialView?: CalendarViewMode }) {
  const t = useT();
  const locale = useLocale();
  const [events, setEvents] = useState<Ev[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [settledKey, setSettledKey] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [view, setView] = useState<CalendarViewMode>(initialView ?? 'month');
  const [cursor, setCursor] = useState(() => startOfDay(new Date()));
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  // A phone gets the agenda unless the reader has picked something else: the
  // month grid is the whole reason this component was unusable on mobile.
  useEffect(() => {
    if (initialView) return;
    const saved = window.localStorage.getItem(VIEW_STORAGE_KEY);
    if (saved && (VIEWS as string[]).includes(saved)) {
      setView(saved as CalendarViewMode);
      return;
    }
    if (window.matchMedia('(max-width: 767px)').matches) setView('agenda');
  }, [initialView]);

  const pickView = (next: CalendarViewMode) => {
    setView(next);
    setSelectedDay(null);
    try {
      window.localStorage.setItem(VIEW_STORAGE_KEY, next);
    } catch {
      // Private mode / storage disabled — the view just won't be remembered.
    }
  };

  // The window on screen. Everything else (fetching, bucketing, the header
  // label) is derived from it, so adding a view means adding a case here.
  const range = useMemo(() => {
    if (view === 'day') return { start: startOfDay(cursor), end: addDays(startOfDay(cursor), 1) };
    if (view === 'week') return { start: startOfWeek(cursor), end: addDays(startOfWeek(cursor), 7) };
    if (view === 'agenda') {
      const today = startOfDay(new Date());
      return { start: today, end: addDays(today, AGENDA_DAYS) };
    }
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    return { start: startOfWeek(first), end: addDays(startOfWeek(first), 42) };
  }, [view, cursor]);

  const fetchKey = `${range.start.toISOString()}|${range.end.toISOString()}`;
  useEffect(() => {
    const controller = new AbortController();
    const [from, to] = fetchKey.split('|');

    const load = async () => {
      setLoading(true);
      setLoadError(false);
      const qs = new URLSearchParams({ from, to });
      try {
        const res = await fetch(`/api/calendar-events?${qs}`, { signal: controller.signal });
        if (!res.ok) throw new Error('Failed to load calendar events');
        const d = await res.json();
        setEvents(d.events ?? []);
        setSettledKey(fetchKey);
      } catch {
        if (!controller.signal.aborted) {
          setLoadError(true);
          setSettledKey(fetchKey);
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };

    load();
    return () => controller.abort();
  }, [fetchKey, retryKey]);

  // A range change is pending immediately, before its effect runs. Events from
  // the previous range stay in memory but are not rendered as if they belonged
  // to the new range.
  const requestPending = loading || settledKey !== fetchKey;
  const currentError = !requestPending && loadError;
  const displayedEvents = useMemo(
    () => (!requestPending && !currentError ? events : []),
    [currentError, events, requestPending]
  );
  const retry = useCallback(() => {
    setLoading(true);
    setLoadError(false);
    setRetryKey((key) => key + 1);
  }, []);

  const byDay = useMemo(() => {
    const map: Record<string, Ev[]> = {};
    for (const e of displayedEvents) (map[dayKey(new Date(e.date))] ||= []).push(e);
    for (const list of Object.values(map)) list.sort((a, b) => a.date.localeCompare(b.date));
    return map;
  }, [displayedEvents]);

  // `h23` — the app writes times as "18:30" throughout (the recurring rule, the
  // time inputs); a 12-hour calendar next to a 24-hour form reads as a bug.
  const time = (iso: string) =>
    new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
  const dayLong = (d: Date) =>
    new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long' }).format(d);

  const todayKey = dayKey(new Date());
  const step = (dir: 1 | -1) => {
    if (view === 'day') setCursor(addDays(cursor, dir));
    else if (view === 'week') setCursor(addDays(cursor, 7 * dir));
    else setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + dir, 1));
    setSelectedDay(null);
  };

  const heading = useMemo(() => {
    if (view === 'agenda') return t.calendar.views.agenda;
    if (view === 'day') return dayLong(cursor);
    if (view === 'week') {
      const s = startOfWeek(cursor);
      const e = addDays(s, 6);
      const fmt = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' });
      return `${fmt.format(s)} – ${fmt.format(e)}`;
    }
    return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(cursor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, cursor, locale, t]);

  // --- shared pieces -------------------------------------------------------

  const Chip = ({ e, withTime = false }: { e: Ev; withTime?: boolean }) => {
    const cls = e.type === 'deadline' && e.overdue ? 'bg-red-100 text-red-700' : CHIP[e.type];
    const inner = (
      <span className="flex items-center gap-1 truncate">
        <EventIcon type={e.type} />
        {withTime && <span className="tabular-nums opacity-70">{time(e.date)}</span>}
        <span className="truncate">{primaryLabel(e)}</span>
      </span>
    );
    return (
      <div title={`${e.title} · ${e.who}`} className={`rounded px-1 py-0.5 text-[10px] ${cls}`}>
        {e.link ? (
          <a href={e.link} target={e.link.startsWith('http') ? '_blank' : undefined} rel="noopener noreferrer">
            {inner}
          </a>
        ) : (
          inner
        )}
      </div>
    );
  };

  // The full-width row used by day/week/agenda and the month's selected-day
  // panel: a real touch target, with the time and both labels spelled out.
  // `compact` is the week column, ~130px wide on a laptop — there the round
  // badge eats a fifth of the line, so it becomes a colour bar and the time
  // moves onto its own line to leave the title the full width.
  const Row = ({ e, compact = false }: { e: Ev; compact?: boolean }) => {
    const cls = e.type === 'deadline' && e.overdue ? 'bg-red-100 text-red-700' : CHIP[e.type];
    const full = (
      <div className="flex items-start gap-2">
        <span className={`mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full ${cls}`}>
          <EventIcon type={e.type} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-gray-800 dark:text-gray-200">
            {primaryLabel(e)}
          </span>
          <span className="block truncate text-xs text-gray-500">
            <span className="tabular-nums">{time(e.date)}</span>
            {secondaryLabel(e) ? ` · ${secondaryLabel(e)}` : ''}
            {e.type === 'series' ? ` · ${t.calendar.recurring}` : ''}
          </span>
        </span>
      </div>
    );
    const tight = (
      <div className={`rounded px-1.5 py-1 ${cls}`}>
        <span className="flex items-center gap-1 text-[10px] tabular-nums opacity-80">
          <EventIcon type={e.type} />
          {time(e.date)}
        </span>
        <span className="mt-0.5 block break-words text-[11px] font-medium leading-tight">{primaryLabel(e)}</span>
      </div>
    );
    // `compact` asks for the tight form *where the column is narrow*: the week's
    // seven columns are ~130px on a laptop but full width once they stack on a
    // phone, so the switch is a breakpoint, not a prop.
    const body = compact ? (
      <>
        <div className="md:hidden">{full}</div>
        <div className="hidden md:block">{tight}</div>
      </>
    ) : (
      full
    );
    return (
      <li data-testid={`calendar-event-${e.id}`} className="rounded-lg px-1 py-1.5 hover:bg-gray-50 dark:hover:bg-gray-800/60">
        {e.link ? (
          <a href={e.link} target={e.link.startsWith('http') ? '_blank' : undefined} rel="noopener noreferrer" className="block">
            {body}
          </a>
        ) : (
          body
        )}
      </li>
    );
  };

  const DaySection = ({ d, compact = false }: { d: Date; compact?: boolean }) => {
    const k = dayKey(d);
    const evs = byDay[k] ?? [];
    return (
      <div
        data-testid={`calendar-day-${k}`}
        className={`rounded-xl border p-2 ${k === todayKey ? 'border-blue-300 bg-blue-50/40 dark:bg-blue-950/20' : 'border-gray-100 dark:border-gray-800'}`}
      >
        <div className="mb-1 flex items-baseline gap-2">
          <span className="text-xs font-semibold text-gray-700 dark:text-gray-300">
            {new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(d)}
          </span>
          <span className="text-xs text-gray-400">{d.getDate()}</span>
        </div>
        {evs.length === 0 ? (
          requestPending || currentError ? null : (
            <p className={`text-xs text-gray-400 ${compact ? '' : 'py-1'}`}>{t.calendar.nothingScheduled}</p>
          )
        ) : (
          <ul className="space-y-0.5">
            {evs.map((e) => (
              <Row key={e.id} e={e} compact={compact} />
            ))}
          </ul>
        )}
      </div>
    );
  };

  // --- views ---------------------------------------------------------------

  const monthCells = useMemo(() => {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const gridStart = startOfWeek(first);
    return Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  }, [cursor]);

  const monthView = (
    <>
      <div className="grid grid-cols-7 gap-px text-xs" data-testid="calendar-month-grid">
        {(t.calendar.weekdays as string[]).map((w) => (
          <div key={w} className="pb-1 text-center font-medium text-gray-500">
            {w}
          </div>
        ))}
        {monthCells.map((d) => {
          const k = dayKey(d);
          const evs = byDay[k] ?? [];
          const outside = d.getMonth() !== cursor.getMonth();
          const selected = selectedDay === k;
          return (
            <button
              type="button"
              key={k}
              onClick={() => setSelectedDay(selected ? null : k)}
              data-testid={`calendar-cell-${k}`}
              className={`min-h-[54px] rounded-lg border p-1 text-left align-top sm:min-h-[68px] ${
                selected
                  ? 'border-blue-400 ring-1 ring-blue-300'
                  : k === todayKey
                    ? 'border-blue-300 bg-blue-50/40 dark:bg-blue-950/20'
                    : outside
                      ? 'border-gray-100 bg-gray-50 dark:border-gray-800 dark:bg-gray-800/50'
                      : 'border-gray-100 dark:border-gray-800'
              }`}
            >
              <div
                className={`mb-0.5 text-[11px] ${outside ? 'text-gray-500 dark:text-gray-300' : 'text-gray-600 dark:text-gray-300'}`}
                data-testid="calendar-day-number"
                data-outside-month={outside ? 'true' : 'false'}
              >
                {d.getDate()}
              </div>
              {/* Phones get dots — three chips in a 45px-wide cell is noise. */}
              <div className="flex flex-wrap gap-0.5 sm:hidden">
                {evs.slice(0, 4).map((e) => (
                  <span key={e.id} className={`h-1.5 w-1.5 rounded-full ${DOT[e.type]}`} />
                ))}
              </div>
              <div className="hidden space-y-0.5 sm:block">
                {evs.slice(0, 3).map((e) => (
                  <Chip key={e.id} e={e} />
                ))}
                {evs.length > 3 && (
                  <div className="px-1 text-[10px] text-gray-400">
                    {t.calendar.moreEvents.replace('{n}', String(evs.length - 3))}
                  </div>
                )}
              </div>
            </button>
          );
        })}
      </div>

      {/* The tapped day, in full — this is how a phone reads the month grid. */}
      {selectedDay && (
        <div className="mt-3" data-testid="calendar-selected-day">
          <h3 className="mb-1 text-sm font-semibold text-gray-800 dark:text-gray-200">
            {dayLong(new Date(`${selectedDay}T00:00:00`))}
          </h3>
          {(byDay[selectedDay] ?? []).length === 0 ? (
            requestPending || currentError ? null : (
              <p className="text-sm text-gray-400">{t.calendar.nothingScheduled}</p>
            )
          ) : (
            <ul className="space-y-0.5">
              {(byDay[selectedDay] ?? []).map((e) => (
                <Row key={e.id} e={e} />
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );

  const weekView = (
    <div className="grid grid-cols-1 gap-2 md:grid-cols-7" data-testid="calendar-week">
      {Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(cursor), i)).map((d) => (
        <DaySection key={dayKey(d)} d={d} compact />
      ))}
    </div>
  );

  const dayView = (
    <div data-testid="calendar-day">
      <DaySection d={startOfDay(cursor)} />
    </div>
  );

  const agendaGroups = useMemo(() => {
    const now = Date.now();
    const upcoming = displayedEvents.filter((e) => new Date(e.date).getTime() >= now - DAY_MS);
    const groups: { key: string; date: Date; items: Ev[] }[] = [];
    for (const e of upcoming) {
      const d = new Date(e.date);
      const k = dayKey(d);
      const last = groups[groups.length - 1];
      if (last && last.key === k) last.items.push(e);
      else groups.push({ key: k, date: d, items: [e] });
    }
    return groups;
  }, [displayedEvents]);

  const agendaView = (
    <div data-testid="calendar-agenda">
      {agendaGroups.length === 0 ? (
        requestPending || currentError ? null : (
          <p className="py-6 text-center text-sm text-gray-400">{t.calendar.agendaEmpty}</p>
        )
      ) : (
        <ul className="space-y-3">
          {agendaGroups.map((g) => (
            <li key={g.key}>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
                {g.key === todayKey ? t.calendar.today : dayLong(g.date)}
              </h3>
              <ul className="space-y-0.5">
                {g.items.map((e) => (
                  <Row key={e.id} e={e} />
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  return (
    <Card>
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-base font-semibold capitalize text-gray-900 dark:text-gray-100 sm:text-lg">{heading}</h2>
        <div className="flex items-center gap-1">
          {view !== 'agenda' && (
            <>
              <button onClick={() => step(-1)} aria-label="prev" className="rounded p-1.5 hover:bg-gray-100 dark:hover:bg-gray-800">
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                onClick={() => {
                  setCursor(startOfDay(new Date()));
                  setSelectedDay(null);
                }}
                className="rounded px-2 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
              >
                {t.calendar.today}
              </button>
              <button onClick={() => step(1)} aria-label="next" className="rounded p-1.5 hover:bg-gray-100 dark:hover:bg-gray-800">
                <ChevronRight className="h-4 w-4" />
              </button>
            </>
          )}
        </div>
      </div>

      {/* View switcher — a segmented control that survives a 320px screen. */}
      <div className="mb-3 flex gap-1 overflow-x-auto rounded-lg bg-gray-100 p-1 dark:bg-gray-800" role="tablist">
        {VIEWS.map((v) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={view === v}
            onClick={() => pickView(v)}
            data-testid={`calendar-view-${v}`}
            className={`flex-1 whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium transition ${
              view === v
                ? 'bg-white text-gray-900 shadow-sm dark:bg-gray-900 dark:text-gray-100'
                : 'text-gray-700 hover:text-gray-900'
            }`}
          >
            {t.calendar.views[v]}
          </button>
        ))}
      </div>

      <div className="relative min-h-40">
        {view === 'month' && monthView}
        {view === 'week' && weekView}
        {view === 'day' && dayView}
        {view === 'agenda' && agendaView}

        {requestPending && (
          <div
            data-testid="calendar-loading"
            role="status"
            aria-live="polite"
            className="absolute inset-0 z-10 rounded-lg bg-white/90 p-4 dark:bg-gray-900/90"
          >
            <span className="sr-only">{t.common.loading}</span>
            <SkeletonRows rows={3} />
          </div>
        )}

        {currentError && (
          <div
            data-testid="calendar-load-error"
            role="alert"
            className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 rounded-lg bg-white/95 p-6 text-center dark:bg-gray-900/95"
          >
            <p className="text-sm text-red-500">{t.calendar.loadError}</p>
            <Button data-testid="calendar-retry" variant="outline" size="sm" onClick={retry}>
              {t.errorBoundary.retry}
            </Button>
          </div>
        )}
      </div>

      {!requestPending && !currentError && events.length === 0 && view !== 'agenda' && (
        <p className="mt-4 text-center text-sm text-gray-400">{t.calendar.empty}</p>
      )}

      <div className="mt-4 flex flex-wrap gap-3 text-xs text-gray-500">
        <span className="flex items-center gap-1">
          <span className="inline-block h-3 w-3 rounded bg-blue-100" />
          {t.calendar.meeting}
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-3 w-3 rounded bg-indigo-100" />
          {t.calendar.recurring}
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-3 w-3 rounded bg-emerald-100" />
          {t.calendar.logged}
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-3 w-3 rounded bg-amber-100" />
          {t.calendar.deadline}
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-3 w-3 rounded bg-red-100" />
          {t.calendar.overdue}
        </span>
      </div>
    </Card>
  );
}
