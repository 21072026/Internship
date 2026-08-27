'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { useT } from '@/i18n/client';

const MAX_NOTE_LENGTH = 1000;
const MAX_SLOTS = 5;

/**
 * Local datetime-local input value -> ISO-8601 UTC instant. Empty or
 * unparseable values are filtered out by the caller before this runs, so
 * this only ever sees a value the <input type="datetime-local"> produced.
 */
function toIsoInstant(localValue: string): string | null {
  const date = new Date(localValue);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Inline "request interview" form for a shortlisted candidate: an optional
 * note (mirrors the backend's 1000-char cap) and up to 5 proposed slots.
 * Both stay fully optional — submitting with neither is a valid, empty
 * request, same as the one-click flow this replaces.
 */
export function InterviewRequestForm({
  onSubmit,
}: {
  onSubmit: (payload: { note?: string; proposedSlots?: string[] }) => Promise<void>;
}) {
  const t = useT();
  const text = t.interviewRequests;
  const [note, setNote] = useState('');
  const [slots, setSlots] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const addSlot = () => setSlots((prev) => (prev.length >= MAX_SLOTS ? prev : [...prev, '']));
  const removeSlot = (index: number) => setSlots((prev) => prev.filter((_, i) => i !== index));
  const updateSlot = (index: number, value: string) =>
    setSlots((prev) => prev.map((slot, i) => (i === index ? value : slot)));

  const submit = async () => {
    setSubmitting(true);
    try {
      const trimmedNote = note.trim();
      const proposedSlots = slots
        .map(toIsoInstant)
        .filter((slot): slot is string => slot !== null)
        .slice(0, MAX_SLOTS);
      await onSubmit({
        note: trimmedNote.length > 0 ? trimmedNote : undefined,
        proposedSlots: proposedSlots.length > 0 ? proposedSlots : undefined,
      });
      setNote('');
      setSlots([]);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="w-full space-y-2 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
      <Textarea
        data-testid="interview-request-note"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder={text.note}
        maxLength={MAX_NOTE_LENGTH}
        showCounter
        rows={2}
      />
      {slots.length > 0 && (
        <div className="space-y-2">
          {slots.map((slot, index) => (
            <div key={index} className="flex items-center gap-2">
              <Input
                type="datetime-local"
                data-testid={`interview-request-slot-${index}`}
                value={slot}
                onChange={(e) => updateSlot(index, e.target.value)}
                className="flex-1"
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                data-testid={`interview-request-remove-slot-${index}`}
                onClick={() => removeSlot(index)}
              >
                {text.removeSlot}
              </Button>
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="interview-request-add-slot"
            disabled={slots.length >= MAX_SLOTS}
            onClick={addSlot}
          >
            {text.addSlot}
          </Button>
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {text.slotsCount.replace('{count}', String(slots.length)).replace('{max}', String(MAX_SLOTS))}
          </span>
        </div>
        <Button size="sm" data-testid="interview-request-submit" disabled={submitting} onClick={() => void submit()}>
          {text.requestInterview}
        </Button>
      </div>
    </div>
  );
}
