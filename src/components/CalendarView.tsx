'use client';

import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Video, Flag } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { useT, useLocale } from '@/i18n/client';

interface Ev {
  id: string;
  type: 'meeting' | 'deadline';
  title: string;
  who: string;
  date: string;
  overdue?: boolean;
  link?: string | null;
}

const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// A month-grid calendar of meetings + stage deadlines. Month navigation is
// purely client-side; all events are fetched once.
export function CalendarView() {
  const t = useT();
  const locale = useLocale();
  const [events, setEvents] = useState<Ev[]>([]);
  const [cursor, setCursor] = useState(() => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), 1); });

  useEffect(() => {
    fetch('/api/calendar-events').then((r) => (r.ok ? r.json() : { events: [] })).then((d) => setEvents(d.events ?? []));
  }, []);

  const byDay = useMemo(() => {
    const map: Record<string, Ev[]> = {};
    for (const e of events) (map[dayKey(new Date(e.date))] ||= []).push(e);
    return map;
  }, [events]);

  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const first = new Date(year, month, 1);
  const startWeekday = (first.getDay() + 6) % 7; // Monday-first
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayKey = dayKey(new Date());

  const cells: (Date | null)[] = [
    ...Array.from({ length: startWeekday }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => new Date(year, month, i + 1)),
  ];
  const weekdays = t.calendar.weekdays as string[];
  const monthName = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(cursor);

  return (
    <Card>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-gray-900 capitalize">{monthName}</h2>
        <div className="flex gap-1">
          <button onClick={() => setCursor(new Date(year, month - 1, 1))} aria-label="prev" className="p-1.5 rounded hover:bg-gray-100"><ChevronLeft className="h-4 w-4" /></button>
          <button onClick={() => { const n = new Date(); setCursor(new Date(n.getFullYear(), n.getMonth(), 1)); }} className="px-2 text-sm text-gray-600 hover:bg-gray-100 rounded">{t.calendar.today}</button>
          <button onClick={() => setCursor(new Date(year, month + 1, 1))} aria-label="next" className="p-1.5 rounded hover:bg-gray-100"><ChevronRight className="h-4 w-4" /></button>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-px text-xs">
        {weekdays.map((w) => <div key={w} className="text-center font-medium text-gray-500 pb-1">{w}</div>)}
        {cells.map((d, i) => {
          if (!d) return <div key={`e${i}`} />;
          const k = dayKey(d);
          const evs = byDay[k] ?? [];
          return (
            <div key={k} className={`min-h-[68px] rounded-lg border p-1 ${k === todayKey ? 'border-blue-300 bg-blue-50/40' : 'border-gray-100'}`}>
              <div className="text-gray-400 text-[11px] mb-0.5">{d.getDate()}</div>
              <div className="space-y-0.5">
                {evs.map((e) => {
                  const cls = e.type === 'deadline'
                    ? (e.overdue ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700')
                    : 'bg-blue-100 text-blue-700';
                  const inner = (
                    <span className="flex items-center gap-1 truncate">
                      {e.type === 'deadline' ? <Flag className="h-3 w-3 flex-shrink-0" /> : <Video className="h-3 w-3 flex-shrink-0" />}
                      <span className="truncate">{e.who}</span>
                    </span>
                  );
                  return (
                    <div key={e.id} title={`${e.title} · ${e.who}`} className={`rounded px-1 py-0.5 text-[10px] ${cls}`}>
                      {e.link ? <a href={e.link} target={e.link.startsWith('http') ? '_blank' : undefined} rel="noopener noreferrer">{inner}</a> : inner}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex gap-4 mt-4 text-xs text-gray-500">
        <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-blue-100 inline-block" />{t.calendar.meeting}</span>
        <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-amber-100 inline-block" />{t.calendar.deadline}</span>
        <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-red-100 inline-block" />{t.calendar.overdue}</span>
      </div>
    </Card>
  );
}
