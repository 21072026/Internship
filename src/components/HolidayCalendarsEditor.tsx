'use client';

// Holiday calendars for business-day stage SLAs (#1638): list, add, edit,
// delete. A calendar is a name and a pasted `YYYY-MM-DD, label` list — the
// server parses it with the same parseHolidayList() and says which lines it
// did not understand. GET/POST /api/admin/holiday-calendars, PUT/DELETE /[id].

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';

interface Calendar {
  id: string;
  name: string;
  holidays: { date: string; label: string }[];
}

export function HolidayCalendarsEditor({ onChange }: { onChange?: () => void }) {
  const t = useT();
  const S = t.stageSla;
  const [calendars, setCalendars] = useState<Calendar[]>([]);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/holiday-calendars');
    if (res.ok) setCalendars((await res.json()).calendars ?? []);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const open = (c: Calendar | null) => {
    setNote(null);
    setEditing(c ? c.id : 'new');
    setName(c?.name ?? '');
    setText(c ? c.holidays.map((h) => (h.label ? `${h.date}, ${h.label}` : h.date)).join('\n') : '');
  };

  const save = async () => {
    if (!editing || !name.trim()) return;
    setBusy(true);
    try {
      const res = await fetch(editing === 'new' ? '/api/admin/holiday-calendars' : `/api/admin/holiday-calendars/${editing}`, {
        method: editing === 'new' ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), text }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        const rejected: number[] = body.rejected ?? [];
        setNote(
          S.calendarSaved.replace('{n}', String(body.saved ?? 0)) +
            (rejected.length ? ` ${S.calendarRejected.replace('{lines}', rejected.join(', '))}` : '')
        );
        setEditing(null);
        await load();
        onChange?.();
      } else {
        setNote(body.error ?? t.common.error);
      }
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    try {
      await fetch(`/api/admin/holiday-calendars/${id}`, { method: 'DELETE' });
      await load();
      onChange?.();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-6 border-t border-gray-200 dark:border-gray-700 pt-4" data-testid="holiday-calendars">
      <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200">{S.calendarsTitle}</h3>
      <p className="text-xs text-gray-500 mt-1 mb-3">{S.calendarsHint}</p>
      {note && <p className="text-xs text-gray-700 dark:text-gray-300 mb-2" data-testid="holiday-calendar-note">{note}</p>}
      <ul className="space-y-1 mb-3">
        {calendars.map((c) => (
          <li key={c.id} className="flex items-center gap-3 text-sm">
            <span className="flex-1">{c.name}</span>
            <span className="text-xs text-gray-500">{S.calendarCount.replace('{n}', String(c.holidays.length))}</span>
            <button type="button" className="text-xs text-blue-600 hover:underline" onClick={() => open(c)}>
              {S.calendarEdit}
            </button>
            <button type="button" className="text-xs text-red-600 hover:underline" disabled={busy} onClick={() => remove(c.id)}>
              {S.calendarDelete}
            </button>
          </li>
        ))}
      </ul>
      {editing ? (
        <div className="space-y-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={S.calendarName}
            aria-label={S.calendarName}
            maxLength={120}
            data-testid="holiday-calendar-name"
            className="w-full rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-800 px-2 py-1 text-sm"
          />
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={6}
            aria-label={S.calendarDates}
            placeholder={S.calendarDates}
            data-testid="holiday-calendar-dates"
            className="w-full rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-800 px-2 py-1 text-sm font-mono"
          />
          <div className="flex gap-2">
            <Button size="sm" loading={busy} onClick={save} disabled={!name.trim()} data-testid="holiday-calendar-save">
              {S.calendarSave}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
              {t.common.cancel}
            </Button>
          </div>
        </div>
      ) : (
        <Button size="sm" variant="outline" onClick={() => open(null)} data-testid="holiday-calendar-new">
          {S.calendarNew}
        </Button>
      )}
    </div>
  );
}
