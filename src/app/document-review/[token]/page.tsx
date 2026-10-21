'use client';

import { use, useEffect, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { BrandTile } from '@/components/BrandMark';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Textarea';
import { useT } from '@/i18n/client';

// The external reviewer's page (#1859): one document, one step, approve or
// reject — and nothing else. No navigation, no session; the emailed token is
// the credential and stops working once the step is decided.

interface Review { title: string; requirement: string | null; owner: string | null; step: number; steps: number }

export default function DocumentReviewTokenPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const t = useT();
  const text = t.documentReview;
  const [review, setReview] = useState<Review | null | undefined>(undefined);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(`/api/document-review/${token}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => setReview(body))
      .catch(() => setReview(null));
  }, [token]);

  const decide = async (decision: 'APPROVED' | 'REJECTED') => {
    if (!review) return;
    setError('');
    if (decision === 'REJECTED' && !note.trim()) { setError(text.reasonRequired); return; }
    setBusy(true);
    try {
      const res = await fetch(`/api/document-review/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step: review.step, decision, ...(note.trim() ? { note: note.trim() } : {}) }),
      });
      if (res.ok) setDone(true);
      else if (res.status === 404 || res.status === 409) setReview(null);
      else setError(text.failed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="min-h-screen bg-gray-50 dark:bg-gray-950 flex items-center justify-center p-4" data-testid="document-review-page">
      <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-lg dark:bg-gray-900">
        <div className="mb-4 flex items-center gap-3">
          <BrandTile />
          <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">{text.tokenTitle}</h1>
        </div>
        {review === undefined ? (
          <p className="text-sm text-gray-600 dark:text-gray-400">{t.common.loading}</p>
        ) : done ? (
          <p className="flex items-center gap-2 text-green-700 dark:text-green-400" role="status" data-testid="document-review-done">
            <CheckCircle2 className="h-5 w-5" aria-hidden="true" />{text.tokenDone}
          </p>
        ) : review === null ? (
          <p className="text-sm text-gray-700 dark:text-gray-300" data-testid="document-review-gone">{text.tokenGone}</p>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-gray-700 dark:text-gray-300">
              {text.tokenIntro
                .replace('{owner}', review.owner ?? '—')
                .replace('{requirement}', review.requirement ?? review.title)
                .replace('{step}', String(review.step))
                .replace('{steps}', String(review.steps))}
            </p>
            <a href={`/api/document-review/${token}/file`} className="inline-block text-sm font-medium text-blue-700 hover:underline dark:text-blue-300">
              {text.download}: {review.title}
            </a>
            <Textarea aria-label={text.reason} placeholder={text.reason} value={note} onChange={(e) => setNote(e.target.value)} data-testid="document-review-token-note" />
            {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
            <div className="flex gap-2">
              <Button disabled={busy} onClick={() => void decide('APPROVED')} data-testid="document-review-token-approve">{text.approve}</Button>
              <Button variant="outline" disabled={busy} onClick={() => void decide('REJECTED')} data-testid="document-review-token-reject">{text.reject}</Button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
