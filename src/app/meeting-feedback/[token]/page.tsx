'use client';

import { use, useEffect, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';

// The page a "how was it?" e-mail button opens (#1896). The click IS the
// answer: the page records the rating its token carries as soon as it loads —
// from the browser, because mail scanners prefetch links but do not run
// scripts — and then offers an optional note. No login.

type State = 'saving' | 'saved' | 'expired' | 'invalid';

export default function MeetingFeedbackPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const t = useT();
  const f = t.meetingFeedback;
  const [state, setState] = useState<State>('saving');
  const [rating, setRating] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [noteSaved, setNoteSaved] = useState(false);
  const url = `/api/meeting-feedback/${encodeURIComponent(token)}`;

  useEffect(() => {
    let cancelled = false;
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 410) return setState('expired');
        if (!res.ok) return setState('invalid');
        const d = await res.json();
        setRating(d.feedback?.happened ? d.feedback.helpfulness : 0);
        setNote(d.feedback?.note ?? '');
        setState('saved');
      })
      .catch(() => !cancelled && setState('invalid'));
    return () => {
      cancelled = true;
    };
  }, [url]);

  const saveNote = async () => {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note }) });
    setNoteSaved(res.ok);
  };

  return (
    <main className="mx-auto max-w-lg px-4 py-16" data-testid="meeting-feedback-page">
      <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-4">{f.pageTitle}</h1>
      {state === 'saving' && <p className="text-gray-500">{f.saving}</p>}
      {state === 'expired' && <p className="text-gray-600" data-testid="meeting-feedback-expired">{f.expired}</p>}
      {state === 'invalid' && <p className="text-gray-600" data-testid="meeting-feedback-invalid">{f.invalid}</p>}
      {state === 'saved' && (
        <div className="space-y-4">
          <p className="flex items-center gap-2 text-green-700" data-testid="meeting-feedback-saved">
            <CheckCircle2 className="h-5 w-5" />
            {rating === 0 ? f.savedDidNotMeet : f.saved.replace('{answer}', `${rating}/5`)}
          </p>
          <label className="block text-sm">
            <span className="block font-medium text-gray-700 dark:text-gray-300 mb-1.5">{f.note}</span>
            <textarea
              value={note}
              onChange={(e) => {
                setNote(e.target.value);
                setNoteSaved(false);
              }}
              maxLength={2000}
              rows={3}
              data-testid="meeting-feedback-note"
              className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
          <div className="flex items-center gap-3">
            <Button type="button" size="sm" variant="outline" onClick={saveNote} data-testid="meeting-feedback-note-save">
              {f.noteSave}
            </Button>
            {noteSaved && <span className="text-sm text-green-700">{f.noteSaved}</span>}
          </div>
          <p className="text-xs text-gray-500">{f.privacy}</p>
        </div>
      )}
    </main>
  );
}
