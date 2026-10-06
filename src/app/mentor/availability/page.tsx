'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import Link from 'next/link';
import { Trash2, Globe, Pencil, Plane } from 'lucide-react';
import { useT, useLocale } from '@/i18n/client';
import { apiErrorMessage } from '@/lib/apiErrorMessage';
import { calendarDate } from '@/lib/availabilitySlots';
import { BookingRulesCard } from '@/components/availability/BookingRulesCard';

interface Slot { id: string; weekday: number; startTime: string; endTime: string; date?: string | null; note?: string | null }
interface Away { id: string; startDate: string; endDate: string; reason?: string | null }
interface Clash { startTime: string; endTime: string; date?: string | null }

const timeInput = 'rounded-lg border border-gray-300 dark:border-gray-600 dark:bg-gray-900 px-3 py-2 text-sm';

export default function AvailabilityPage() {
  const t = useT();
  const locale = useLocale();
  const days = t.availability.days as string[];
  const [slots, setSlots] = useState<Slot[]>([]);
  const [away, setAway] = useState<Away[]>([]);
  const [oneOff, setOneOff] = useState(false);
  const [weekday, setWeekday] = useState('1');
  const [date, setDate] = useState('');
  const [startTime, setStartTime] = useState('09:00');
  const [endTime, setEndTime] = useState('10:00');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  // Inline edit (#2001): one row at a time, in place, instead of delete + retype.
  const [editing, setEditing] = useState<Slot | null>(null);
  const [editError, setEditError] = useState('');
  const [awayFrom, setAwayFrom] = useState('');
  const [awayTo, setAwayTo] = useState('');
  const [awayReason, setAwayReason] = useState('');
  const [awayError, setAwayError] = useState('');
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
    setAway(d.exceptions ?? []);
    setZone(d.timezone ?? '');
    setZoneSet(d.timezoneSet !== false);
    // The delete box below describes this list and has no dismiss control of
    // its own; a list that just reloaded successfully makes it stale (#1355).
    // `confirmRemove` re-sets it after its own reload, so a real failure stays.
    setDeleteError('');
  }, []);
  useEffect(() => { load(); }, [load]);

  // A calendar date rendered on the app locale, read as the date it is — no
  // zone shift, so "2026-10-08" never shows as the 7th west of Greenwich.
  const fmtDate = (d: string) =>
    new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${calendarDate(d)}T00:00:00Z`));

  // 409 carries the interval it collided with, so the message can name it
  // rather than saying "that didn't work" (#1363) — and the date, for a one-off.
  const clashMessage = (clash: Clash) =>
    (clash.date ? t.availability.overlapOn.replace('{date}', fmtDate(clash.date)) : t.availability.overlap)
      .replace('{from}', clash.startTime)
      .replace('{to}', clash.endTime);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true); setError('');
    try {
      const res = await fetch('/api/availability', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          weekday: Number(weekday),
          startTime,
          endTime,
          ...(oneOff ? { date } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
        }),
      });
      const d = await res.json();
      if (!res.ok) {
        if (d.code === 'overlap' && d.clash) throw new Error(clashMessage(d.clash));
        throw new Error(d.error || 'Failed');
      }
      setNote('');
      await load();
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : 'Failed');
    } finally {
      setSaving(false);
    }
  };

  const saveEdit = async () => {
    if (!editing) return;
    setSaving(true); setEditError('');
    try {
      const res = await fetch('/api/availability', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: editing.id,
          startTime: editing.startTime,
          endTime: editing.endTime,
          note: editing.note?.trim() || null,
          ...(editing.date ? { date: calendarDate(editing.date) } : { weekday: editing.weekday }),
        }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        setEditError(d.code === 'overlap' && d.clash ? clashMessage(d.clash) : d.error || t.common.error);
        return;
      }
      setEditing(null);
      await load();
    } finally {
      setSaving(false);
    }
  };

  const addAway = async (e: React.FormEvent) => {
    e.preventDefault();
    setAwayError('');
    const res = await fetch('/api/availability/exceptions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startDate: awayFrom, endDate: awayTo || awayFrom, ...(awayReason.trim() ? { reason: awayReason.trim() } : {}) }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setAwayError(d.error || t.common.error);
      return;
    }
    setAwayFrom(''); setAwayTo(''); setAwayReason('');
    await load();
  };

  const removeAway = async (id: string) => {
    setAwayError('');
    const res = await fetch(`/api/availability/exceptions?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) setAwayError(apiErrorMessage(res, t.common, t.common.deleteFailed));
    await load();
  };

  const remove = (id: string) => setDeleteId(id);

  const weekly = slots.filter((s) => !s.date);
  const oneOffs = slots.filter((s) => s.date).sort((a, b) => calendarDate(a.date!).localeCompare(calendarDate(b.date!)) || a.startTime.localeCompare(b.startTime));
  // [weekdayIndex, slots][] in weekday order, preserving the API's time order
  // inside each day.
  const byDay = Array.from(
    weekly.reduce((m, s) => m.set(s.weekday, [...(m.get(s.weekday) ?? []), s]), new Map<number, Slot[]>())
  ).sort((a, b) => a[0] - b[0]);

  // Away right now? The window is calendar dates in the mentor's zone; the
  // browser's own date is close enough for a banner — the offer side is exact.
  const todayLocal = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const awayNow = away.find((a) => calendarDate(a.startDate) <= todayLocal && todayLocal <= calendarDate(a.endDate));

  const confirmRemove = async () => {
    if (!deleteId || deleting) return;
    setDeleting(true);
    setDeleteError('');
    let failure = '';
    // #1355: the response was never read, so a rejected delete quietly reloaded
    // and the slot reappeared with no explanation. Say why — in the slots card,
    // not the add-slot form's box. Only the DELETE is guarded here.
    try {
      const res = await fetch(`/api/availability?id=${deleteId}`, { method: 'DELETE' });
      if (!res.ok) failure = apiErrorMessage(res, t.common, t.common.deleteFailed);
    } catch {
      failure = t.common.deleteFailed;
    } finally {
      setDeleting(false);
      setDeleteId(null);
    }
    // Outside the try, and swallowing its own error: a reload that throws must
    // not be reported as a failed delete after the slot is already gone. It runs
    // on the failure path too, so a slot the server no longer has (404) stops
    // being listed instead of sitting there failing on every retry.
    await load().catch(() => {});
    // After load(), which clears the box — a successful reload says nothing
    // about whether this delete worked.
    if (failure) setDeleteError(failure);
  };

  const slotRow = (s: Slot) =>
    editing?.id === s.id ? (
      <div key={s.id} data-testid={`slot-edit-${s.id}`} className="py-1.5 space-y-2">
        <div className="flex flex-wrap items-end gap-2">
          {editing.date ? (
            <input type="date" aria-label={t.availability.date} value={calendarDate(editing.date)} onChange={(e) => setEditing({ ...editing, date: e.target.value })} className={timeInput} />
          ) : (
            <div className="min-w-[130px]">
              <Select aria-label={t.availability.day} value={String(editing.weekday)} onChange={(e) => setEditing({ ...editing, weekday: Number(e.target.value) })}
                options={days.map((d, i) => ({ value: String(i), label: d }))} />
            </div>
          )}
          <input type="time" aria-label={t.availability.from} value={editing.startTime} onChange={(e) => setEditing({ ...editing, startTime: e.target.value })} className={timeInput} />
          <input type="time" aria-label={t.availability.to} value={editing.endTime} onChange={(e) => setEditing({ ...editing, endTime: e.target.value })} className={timeInput} />
          <input type="text" aria-label={t.availability.note} placeholder={t.availability.notePlaceholder} maxLength={120} value={editing.note ?? ''} onChange={(e) => setEditing({ ...editing, note: e.target.value })} className={`${timeInput} flex-1 min-w-[140px]`} />
          <Button size="sm" loading={saving} onClick={saveEdit} data-testid="slot-edit-save">{t.common.save}</Button>
          <Button size="sm" variant="outline" onClick={() => { setEditing(null); setEditError(''); }}>{t.common.cancel}</Button>
        </div>
        {editError && <p data-testid="slot-edit-error" className="text-sm text-red-600">{editError}</p>}
      </div>
    ) : (
      <div key={s.id} data-testid={`slot-${s.id}`} className="flex items-center justify-between gap-2 text-sm">
        <span className="text-gray-900 dark:text-gray-100">
          {s.startTime}–{s.endTime}
          {s.note && <span className="ml-2 text-gray-500 dark:text-gray-400">· {s.note}</span>}
        </span>
        <span className="flex items-center">
          <button onClick={() => { setEditing({ ...s }); setEditError(''); }} aria-label={t.common.edit} className="p-2 text-gray-400 hover:text-blue-600 dark:hover:text-blue-300"><Pencil className="h-4 w-4" /></button>
          <button onClick={() => remove(s.id)} aria-label={t.availability.remove} className="p-2 text-gray-400 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>
        </span>
      </div>
    );

  return (
    <>
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.availability.title}</h1>
        <p className="text-gray-500 mt-1">{t.availability.subtitle}</p>
      </div>

      {awayNow && (
        <div data-testid="availability-away-banner" className="mb-4 flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2.5 text-sm text-blue-700">
          <Plane className="h-4 w-4 shrink-0 mt-0.5" aria-hidden />
          <p>{t.availability.away.banner.replace('{from}', fmtDate(awayNow.startDate)).replace('{to}', fmtDate(awayNow.endDate))}</p>
        </div>
      )}

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

      <Card className="mb-6 max-w-2xl">
        <CardHeader><CardTitle>{t.availability.addSlot}</CardTitle></CardHeader>
        {error && <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>}
        <form onSubmit={add} className="flex flex-wrap items-end gap-3">
          <div className="min-w-[160px]">
            <Select label={t.availability.kind} value={oneOff ? 'once' : 'weekly'} onChange={(e) => setOneOff(e.target.value === 'once')} data-testid="slot-kind"
              options={[{ value: 'weekly', label: t.availability.weekly }, { value: 'once', label: t.availability.oneOff }]} />
          </div>
          {oneOff ? (
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">{t.availability.date}</label>
              <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} data-testid="slot-date" className={timeInput} />
            </div>
          ) : (
            <div className="min-w-[140px]">
              <Select label={t.availability.day} value={weekday} onChange={(e) => setWeekday(e.target.value)}
                options={days.map((d, i) => ({ value: String(i), label: d }))} />
            </div>
          )}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">{t.availability.from}</label>
            <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} className={timeInput} />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">{t.availability.to}</label>
            <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} className={timeInput} />
          </div>
          <div className="flex-1 min-w-[140px]">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">{t.availability.note}</label>
            <input type="text" value={note} maxLength={120} placeholder={t.availability.notePlaceholder} onChange={(e) => setNote(e.target.value)} className={`${timeInput} w-full`} />
          </div>
          <Button type="submit" loading={saving}>{t.availability.add}</Button>
        </form>
      </Card>

      <BookingRulesCard />

      <Card className="mb-6">
        <CardHeader><CardTitle>{t.availability.yourSlots} ({slots.length})</CardTitle></CardHeader>
        {deleteError && (
          <div
            data-testid="availability-delete-error"
            className="mb-3 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm"
          >
            {deleteError}
          </div>
        )}
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
                <div className="space-y-1">{daySlots.map(slotRow)}</div>
              </div>
            ))}
            {oneOffs.length > 0 && (
              <div className="py-3 first:pt-0 last:pb-0" data-testid="availability-one-offs">
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1.5">{t.availability.oneOffs}</p>
                <div className="space-y-1">
                  {oneOffs.map((s) => (
                    <div key={s.id} className="flex items-baseline gap-3">
                      <span className="w-28 shrink-0 text-xs text-gray-500 dark:text-gray-400">{fmtDate(s.date!)}</span>
                      <div className="flex-1">{slotRow(s)}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </Card>

      <Card data-testid="availability-away">
        <CardHeader>
          <div>
            <CardTitle>{t.availability.away.title}</CardTitle>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{t.availability.away.subtitle}</p>
          </div>
        </CardHeader>
        {awayError && <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{awayError}</div>}
        <form onSubmit={addAway} className="flex flex-wrap items-end gap-3 mb-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">{t.availability.away.from}</label>
            <input type="date" required value={awayFrom} onChange={(e) => setAwayFrom(e.target.value)} data-testid="away-from" className={timeInput} />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">{t.availability.away.to}</label>
            <input type="date" value={awayTo} min={awayFrom || undefined} onChange={(e) => setAwayTo(e.target.value)} data-testid="away-to" className={timeInput} />
          </div>
          <div className="flex-1 min-w-[160px]">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">{t.availability.away.reason}</label>
            <input type="text" maxLength={120} value={awayReason} onChange={(e) => setAwayReason(e.target.value)} className={`${timeInput} w-full`} />
          </div>
          <Button type="submit" variant="outline" data-testid="away-add">{t.availability.away.add}</Button>
        </form>
        {away.length === 0 ? (
          <p className="text-sm text-gray-400">{t.availability.away.none}</p>
        ) : (
          <ul className="divide-y divide-gray-100 dark:divide-gray-800">
            {away.map((a) => (
              <li key={a.id} data-testid={`away-${a.id}`} className="flex items-center justify-between gap-2 py-2 text-sm">
                <span className="text-gray-900 dark:text-gray-100">
                  {t.availability.away.range.replace('{from}', fmtDate(a.startDate)).replace('{to}', fmtDate(a.endDate))}
                  {a.reason && <span className="ml-2 text-gray-500 dark:text-gray-400">· {a.reason}</span>}
                </span>
                <button onClick={() => removeAway(a.id)} aria-label={t.availability.away.remove} className="p-2 text-gray-400 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>
              </li>
            ))}
          </ul>
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
