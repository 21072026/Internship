'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';

// The inline "how was the meeting?" card (#1896), shown right after someone
// marks a meeting as ended. Two questions at most: did it take place, and —
// only if it did — how helpful it was. "We didn't meet" is its own answer and
// is never scored as a bad meeting. Answering in the app means the e-mail ask
// is never sent for this person.

export function MeetingFeedbackCard({ meetingId, onDone }: { meetingId: string; onDone: () => void }) {
  const t = useT();
  const f = t.meetingFeedback;
  const [happened, setHappened] = useState<boolean | null>(null);
  const [helpfulness, setHelpfulness] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const send = async () => {
    if (happened === null) return;
    setSaving(true);
    const res = await fetch(`/api/meetings/${encodeURIComponent(meetingId)}/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ happened, helpfulness: happened ? helpfulness : null, note: note.trim() || null }),
    }).catch(() => null);
    setSaving(false);
    if (res?.ok) {
      setSaved(true);
      setTimeout(onDone, 1500);
    }
  };

  if (saved) {
    return (
      <div className="mb-6 rounded-xl border border-green-200 bg-green-50 p-4 text-sm text-green-800 dark:border-green-800" data-testid="meeting-feedback-thanks">
        {f.thanks}
      </div>
    );
  }

  return (
    <div className="mb-6 rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900" data-testid="meeting-feedback-card">
      <p className="font-medium text-gray-900 dark:text-gray-100">{f.cardTitle}</p>
      <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">{f.didMeet}</p>
      <div className="mt-1 flex flex-wrap gap-2">
        <Button type="button" size="sm" variant={happened === true ? 'primary' : 'outline'} onClick={() => setHappened(true)} data-testid="meeting-feedback-happened-yes">
          {f.yes}
        </Button>
        <Button type="button" size="sm" variant={happened === false ? 'primary' : 'outline'} onClick={() => setHappened(false)} data-testid="meeting-feedback-happened-no">
          {f.no}
        </Button>
      </div>
      {happened && (
        <>
          <p className="mt-3 text-sm text-gray-600 dark:text-gray-400">{f.helpfulness}</p>
          <div className="mt-1 flex items-center gap-1" role="radiogroup" aria-label={f.helpfulness}>
            <span className="mr-1 text-xs text-gray-400">{f.low}</span>
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={helpfulness === n}
                onClick={() => setHelpfulness(n)}
                data-testid={`meeting-feedback-rate-${n}`}
                className={`h-9 w-9 rounded-lg border text-sm font-medium ${helpfulness === n ? 'border-blue-600 bg-blue-600 text-white' : 'border-gray-300 text-gray-700 dark:text-gray-200'}`}
              >
                {n}
              </button>
            ))}
            <span className="ml-1 text-xs text-gray-400">{f.high}</span>
          </div>
        </>
      )}
      {happened !== null && (
        <label className="mt-3 block text-sm">
          <span className="block text-gray-600 dark:text-gray-400 mb-1">{f.note}</span>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} rows={2} className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        </label>
      )}
      <div className="mt-3 flex items-center gap-2">
        <Button type="button" size="sm" onClick={send} disabled={happened === null || (happened && helpfulness === null) || saving} data-testid="meeting-feedback-send">
          {f.send}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone} data-testid="meeting-feedback-skip">
          {f.skip}
        </Button>
      </div>
      <p className="mt-2 text-xs text-gray-500">{f.privacy}</p>
    </div>
  );
}
