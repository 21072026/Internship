'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import Link from 'next/link';
import { Trash2, Globe } from 'lucide-react';
import { useT } from '@/i18n/client';

interface Slot { id: string; weekday: number; startTime: string; endTime: string }

export default function AvailabilityPage() {
  const t = useT();
  const days = t.availability.days as string[];
  const [slots, setSlots] = useState<Slot[]>([]);
  const [weekday, setWeekday] = useState('1');
  const [startTime, setStartTime] = useState('09:00');
  const [endTime, setEndTime] = useState('10:00');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  // A slot has no zone of its own: it is read in the mentor's profile time zone
  // (#1363). The endpoint says which, and whether it was actually chosen or
  // fell back — the two get different copy, because "your hours are Istanbul"
  // is reassuring when you picked it and misleading when you did not.
  const [zone, setZone] = useState('');
  const [zoneSet, setZoneSet] = useState(true);

  const load = useCallback(async () => {
    const res = await fetch('/api/availability');
    if (!res.ok) return;
    const d = await res.json();
    setSlots(d.slots ?? []);
    setZone(d.timezone ?? '');
    setZoneSet(d.timezoneSet !== false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true); setError('');
    try {
      const res = await fetch('/api/availability', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ weekday: Number(weekday), startTime, endTime }),
      });
      const d = await res.json();
      if (!res.ok) {
        // 409 carries the interval it collided with, so the message can name it
        // rather than saying "that didn't work" (#1363).
        if (d.code === 'overlap' && d.clash) {
          throw new Error(
            t.availability.overlap.replace('{from}', d.clash.startTime).replace('{to}', d.clash.endTime)
          );
        }
        throw new Error(d.error || 'Failed');
      }
      await load();
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : 'Failed');
    } finally {
      setSaving(false);
    }
  };

  const remove = (id: string) => setDeleteId(id);

  // [weekdayIndex, slots][] in weekday order, preserving the API's time order
  // inside each day.
  const byDay = Array.from(
    slots.reduce((m, s) => m.set(s.weekday, [...(m.get(s.weekday) ?? []), s]), new Map<number, Slot[]>())
  ).sort((a, b) => a[0] - b[0]);

  const confirmRemove = async () => {
    if (!deleteId || deleting) return;
    setDeleting(true);
    try {
      await fetch(`/api/availability?id=${deleteId}`, { method: 'DELETE' });
      await load();
    } finally {
      setDeleting(false);
      setDeleteId(null);
    }
  };

  return (
    <>
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.availability.title}</h1>
        <p className="text-gray-500 mt-1">{t.availability.subtitle}</p>
      </div>

      {zone && (
        <div
          data-testid="availability-zone"
          className={`mb-6 flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm ${
            zoneSet
              ? 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300'
              : 'border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/10 text-amber-800 dark:text-amber-300'
          }`}
        >
          <Globe className="h-4 w-4 shrink-0 mt-0.5" aria-hidden />
          <p>
            {(zoneSet ? t.availability.inZone : t.availability.zoneUnset).replace('{zone}', zone)}
            {!zoneSet && (
              <>
                {' '}
                <Link href="/mentor/profile" className="underline font-medium">
                  {t.availability.zoneSetCta}
                </Link>
              </>
            )}
          </p>
        </div>
      )}

      <Card className="mb-6 max-w-xl">
        <CardHeader><CardTitle>{t.availability.addSlot}</CardTitle></CardHeader>
        {error && <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>}
        <form onSubmit={add} className="flex flex-wrap items-end gap-3">
          <div className="min-w-[140px]">
            <Select label={t.availability.day} value={weekday} onChange={(e) => setWeekday(e.target.value)}
              options={days.map((d, i) => ({ value: String(i), label: d }))} />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.availability.from}</label>
            <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.availability.to}</label>
            <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </div>
          <Button type="submit" loading={saving}>{t.availability.add}</Button>
        </form>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t.availability.yourSlots} ({slots.length})</CardTitle></CardHeader>
        {slots.length === 0 ? (
          <p className="text-center py-8 text-gray-400">{t.availability.none}</p>
        ) : (
          /* Grouped by day rather than one flat list (#1363): the day name used
             to repeat on every row, which at a glance read as noise instead of
             structure. The API already returns weekday-then-time order. */
          <div className="divide-y divide-gray-100 dark:divide-gray-800">
            {byDay.map(([weekdayIndex, daySlots]) => (
              <div key={weekdayIndex} className="py-3 first:pt-0 last:pb-0">
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1.5">
                  {days[weekdayIndex]}
                </p>
                <div className="space-y-1">
                  {daySlots.map((s) => (
                    <div key={s.id} className="flex items-center justify-between text-sm">
                      <span className="text-gray-900 dark:text-gray-100">{s.startTime}–{s.endTime}</span>
                      <button onClick={() => remove(s.id)} aria-label={t.availability.remove} className="p-2 text-gray-400 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
    <ConfirmDialog
      open={deleteId !== null}
      message={t.common.confirmDelete}
      cancelLabel={t.common.cancel}
      confirmLabel={t.common.delete}
      variant="danger"
      loading={deleting}
      onConfirm={confirmRemove}
      onCancel={() => setDeleteId(null)}
    />
    </>
  );
}
