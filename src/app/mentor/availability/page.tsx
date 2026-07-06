'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Trash2 } from 'lucide-react';
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

  const load = useCallback(async () => {
    const res = await fetch('/api/availability');
    if (res.ok) setSlots((await res.json()).slots ?? []);
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
      if (!res.ok) throw new Error(d.error || 'Failed');
      await load();
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : 'Failed');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm(t.common.confirmDelete)) return;
    await fetch(`/api/availability?id=${id}`, { method: 'DELETE' });
    await load();
  };

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.availability.title}</h1>
        <p className="text-gray-500 mt-1">{t.availability.subtitle}</p>
      </div>

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
          <div className="divide-y divide-gray-50">
            {slots.map((s) => (
              <div key={s.id} className="flex items-center justify-between py-2.5 text-sm">
                <span><span className="font-medium text-gray-900">{days[s.weekday]}</span> · {s.startTime}–{s.endTime}</span>
                <button onClick={() => remove(s.id)} aria-label={t.availability.remove} className="p-2 text-gray-400 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
