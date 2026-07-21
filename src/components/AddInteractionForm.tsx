'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';

const TYPES = ['Meeting', 'Feedback', 'Email', 'Call', 'WhatsApp'] as const;

// Compact "log an interaction" form for admins on the candidate detail screen —
// parity with what a mentor can do (#707). Posts to /api/interactions (which
// already authorizes ADMIN) and calls onAdded() to refresh the list.
export function AddInteractionForm({ relationId, onAdded }: { relationId: string; onAdded: () => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<(typeof TYPES)[number]>('Meeting');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [subject, setSubject] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!notes.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/interactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relationId, date, subject: subject || undefined, notes, type }),
      });
      if (res.ok) {
        setSubject('');
        setNotes('');
        setType('Meeting');
        setOpen(false);
        onAdded();
      } else {
        setError(t.logInteraction.failed);
      }
    } catch {
      setError(t.logInteraction.failed);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-2 text-xs font-medium text-blue-600 hover:text-blue-700"
      >
        + {t.logInteraction.add}
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="mt-2 space-y-2 rounded-lg border border-gray-200 bg-gray-50 p-3">
      <div className="flex gap-2">
        <select
          aria-label={t.logInteraction.type}
          value={type}
          onChange={(e) => setType(e.target.value as (typeof TYPES)[number])}
          className="rounded-lg border border-gray-300 px-2 py-1 text-sm"
        >
          {TYPES.map((ty) => (
            <option key={ty} value={ty}>{t.interactionTypes[ty]}</option>
          ))}
        </select>
        <input
          type="date"
          aria-label={t.logInteraction.date}
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="rounded-lg border border-gray-300 px-2 py-1 text-sm"
        />
      </div>
      <input
        type="text"
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
        placeholder={t.logInteraction.subject}
        className="w-full rounded-lg border border-gray-300 px-2 py-1 text-sm"
      />
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        rows={2}
        placeholder={t.logInteraction.notes}
        className="w-full rounded-lg border border-gray-300 px-2 py-1 text-sm"
      />
      {error && <p className="text-xs text-red-600" role="alert">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" loading={busy} disabled={!notes.trim()}>{t.logInteraction.add}</Button>
        <Button type="button" size="sm" variant="outline" onClick={() => setOpen(false)}>{t.common.cancel}</Button>
      </div>
    </form>
  );
}
