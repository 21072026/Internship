'use client';

import { useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';
import { useDurationText } from '@/components/meeting/ConflictNotice';
import { POLICY_LIMITS, type BookingPolicy } from '@/lib/bookingPolicyRule';

// The ONLY place a mentor's five booking rules are edited (#2003). Stored in
// minutes; notice is typed in hours because that is how a person thinks about
// it. An empty field is "no rule". The summary line says the result in one
// sentence, so a mentor can read back what they just told the product.

const EMPTY: BookingPolicy = { minNoticeMinutes: null, bufferMinutes: null, maxPerWeek: null, maxPerMonth: null, defaultSlotMinutes: null };
const input = 'block w-full rounded-lg border border-gray-300 dark:border-gray-600 dark:bg-gray-900 px-3 py-2 text-sm';

type Field = 'notice' | 'buffer' | 'week' | 'month' | 'slot';

export function BookingRulesCard() {
  const t = useT();
  const r = t.availability.rules;
  const duration = useDurationText();
  const [saved, setSaved] = useState<BookingPolicy>(EMPTY);
  const [form, setForm] = useState<Record<Field, string>>({ notice: '', buffer: '', week: '', month: '', slot: '' });
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [error, setError] = useState('');
  // Inputs stay locked until the saved rules arrive: typing into a form the
  // first read then overwrites would save the blanks (and clear the rules).
  const [loaded, setLoaded] = useState(false);

  const fill = (p: BookingPolicy) => {
    setSaved(p);
    setForm({
      notice: p.minNoticeMinutes == null ? '' : String(+(p.minNoticeMinutes / 60).toFixed(2)),
      buffer: p.bufferMinutes == null ? '' : String(p.bufferMinutes),
      week: p.maxPerWeek == null ? '' : String(p.maxPerWeek),
      month: p.maxPerMonth == null ? '' : String(p.maxPerMonth),
      slot: p.defaultSlotMinutes == null ? '' : String(p.defaultSlotMinutes),
    });
  };

  useEffect(() => {
    fetch('/api/availability/policy')
      .then((res) => (res.ok ? res.json() : null))
      .then((d) => d?.policy && fill(d.policy))
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  const num = (v: string) => (v.trim() === '' ? null : Number(v));
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    const notice = num(form.notice);
    const body = {
      minNoticeMinutes: notice == null ? null : Math.round(notice * 60),
      bufferMinutes: num(form.buffer),
      maxPerWeek: num(form.week),
      maxPerMonth: num(form.month),
      defaultSlotMinutes: num(form.slot),
    };
    if (body.maxPerWeek != null && body.maxPerMonth != null && body.maxPerMonth < body.maxPerWeek) {
      setError(r.monthBelowWeek);
      return;
    }
    setStatus('saving');
    const res = await fetch('/api/availability/policy', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) {
      setStatus('idle');
      setError(t.common.error);
      return;
    }
    fill((await res.json()).policy);
    setStatus('saved');
  };

  // The plain-language read-back of what is SAVED, not of what is typed.
  const parts = [
    saved.defaultSlotMinutes != null && r.partSlot.replace('{n}', String(saved.defaultSlotMinutes)),
    saved.minNoticeMinutes != null && saved.minNoticeMinutes > 0 && r.partNotice.replace('{d}', duration(saved.minNoticeMinutes)),
    saved.bufferMinutes != null && saved.bufferMinutes > 0 && r.partBuffer.replace('{n}', String(saved.bufferMinutes)),
    saved.maxPerWeek != null && r.partWeek.replace('{n}', String(saved.maxPerWeek)),
    saved.maxPerMonth != null && r.partMonth.replace('{n}', String(saved.maxPerMonth)),
  ].filter(Boolean) as string[];
  const summary = parts.length ? r.summary.replace('{parts}', parts.join(', ')) : r.none;

  const field = (key: Field, label: string, limits: { min: number; max: number }, step = 1) => (
    <label className="text-sm">
      <span className="block font-medium text-gray-700 dark:text-gray-300 mb-1.5">{label}</span>
      <input
        type="number"
        inputMode="numeric"
        min={limits.min}
        max={limits.max}
        step={step}
        value={form[key]}
        disabled={!loaded}
        onChange={(e) => { setForm({ ...form, [key]: e.target.value }); setStatus('idle'); }}
        data-testid={`rules-${key}`}
        className={input}
      />
    </label>
  );

  return (
    <Card className="mb-6 max-w-2xl" data-testid="booking-rules">
      <CardHeader>
        <div>
          <CardTitle>{r.title}</CardTitle>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{r.subtitle}</p>
        </div>
      </CardHeader>
      <p className="mb-4 text-sm text-gray-800 dark:text-gray-200" data-testid="booking-rules-summary">{summary}</p>
      {error && <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>}
      <form onSubmit={save} className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
        {field('slot', r.slotMinutes, POLICY_LIMITS.defaultSlotMinutes, 5)}
        {field('notice', r.minNoticeHours, { min: 0, max: POLICY_LIMITS.minNoticeMinutes.max / 60 }, 0.5)}
        {field('buffer', r.bufferMinutes, POLICY_LIMITS.bufferMinutes, 5)}
        {field('week', r.maxPerWeek, POLICY_LIMITS.maxPerWeek)}
        {field('month', r.maxPerMonth, POLICY_LIMITS.maxPerMonth)}
        <div className="flex items-center gap-3">
          <Button type="submit" loading={status === 'saving'} disabled={!loaded} data-testid="booking-rules-save">{r.save}</Button>
          {status === 'saved' && <span className="text-sm text-green-700 dark:text-green-400">{r.saved}</span>}
        </div>
      </form>
    </Card>
  );
}
