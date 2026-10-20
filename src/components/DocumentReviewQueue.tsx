'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { Badge } from '@/components/ui/Badge';
import { useLocale, useT } from '@/i18n/client';

// The review steps waiting on the signed-in person (#1859), from
// GET /api/document-reviews: approve or reject the current step of a
// document's chain, or — for an EXTERNAL step — send the link to the person
// who decides it. `hideWhenEmpty` lets a dashboard mount it without an empty card.

type Item = {
  reviewId: string;
  documentId: string;
  title: string;
  owner: { id: string; fullName: string } | null;
  requirement: string | null;
  step: number;
  steps: number;
  reviewerRole: string;
  reviewerEmail: string | null;
};

export function DocumentReviewQueue({ hideWhenEmpty = false }: { hideWhenEmpty?: boolean }) {
  const t = useT();
  const text = t.documentReview;
  const locale = useLocale();
  const [items, setItems] = useState<Item[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/document-reviews?locale=${locale}`);
      if (!res.ok) throw new Error(String(res.status));
      setItems((await res.json()).items ?? []);
      setFailed(false);
    } catch {
      setFailed(true);
      setItems([]);
    }
  }, [locale]);
  useEffect(() => { void load(); }, [load]);

  if (items === null) return null;
  if (hideWhenEmpty && items.length === 0 && !failed) return null;
  return (
    <Card className="mb-6" data-testid="document-review-queue">
      <CardHeader><CardTitle>{text.queueTitle}</CardTitle></CardHeader>
      {failed ? (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">{text.failed}</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-gray-600 dark:text-gray-400" data-testid="document-review-queue-empty">{text.queueEmpty}</p>
      ) : (
        <ul className="divide-y divide-gray-100 dark:divide-gray-800">
          {items.map((item) => <QueueRow key={item.reviewId} item={item} onDone={load} />)}
        </ul>
      )}
    </Card>
  );
}

function QueueRow({ item, onDone }: { item: Item; onDone: () => Promise<void> }) {
  const t = useT();
  const text = t.documentReview;
  const [note, setNote] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const decide = async (decision: 'APPROVED' | 'REJECTED') => {
    setError(''); setMessage('');
    if (decision === 'REJECTED' && !note.trim()) { setError(text.reasonRequired); return; }
    setBusy(true);
    try {
      const res = await fetch(`/api/documents/${item.documentId}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step: item.step, decision, ...(note.trim() ? { note: note.trim() } : {}) }),
      });
      if (res.status === 409) setError(text.conflict);
      else if (!res.ok) { setError(text.failed); return; }
      await onDone();
    } finally {
      setBusy(false);
    }
  };

  const invite = async () => {
    setError(''); setMessage('');
    setBusy(true);
    try {
      const res = await fetch(`/api/documents/${item.documentId}/review/invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) { setError(res.status === 409 ? text.conflict : text.failed); return; }
      setMessage(text.sent);
      setEmail('');
      await onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="space-y-2 py-3" data-testid={`document-review-${item.documentId}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-gray-900 dark:text-gray-100">{item.requirement ?? item.title}</span>
        <Badge variant="info">{text.stepOf.replace('{step}', String(item.step)).replace('{steps}', String(item.steps))}</Badge>
        <Badge>{t.documentRequirements.reviewerRoles[item.reviewerRole as keyof typeof t.documentRequirements.reviewerRoles] ?? item.reviewerRole}</Badge>
      </div>
      <p className="text-sm text-gray-600 dark:text-gray-400">
        {item.owner ? text.submittedBy.replace('{owner}', item.owner.fullName) : null}
        {' · '}
        <a href={`/api/documents/${item.documentId}`} className="text-blue-700 hover:underline dark:text-blue-300">{text.download}</a>
      </p>
      {item.reviewerRole === 'EXTERNAL' ? (
        <div className="space-y-2">
          <p className="text-sm text-gray-700 dark:text-gray-300">{text.externalStep}</p>
          {item.reviewerEmail && <p className="text-sm text-gray-600 dark:text-gray-400">{text.externalSentTo.replace('{email}', item.reviewerEmail)}</p>}
          <div className="flex flex-wrap items-end gap-2">
            <div className="w-72"><Input type="email" label={text.externalEmail} value={email} onChange={(e) => setEmail(e.target.value)} data-testid={`document-review-email-${item.documentId}`} /></div>
            <Button size="sm" disabled={busy || !email.trim()} onClick={() => void invite()} data-testid={`document-review-invite-${item.documentId}`}>
              {item.reviewerEmail ? text.resendLink : text.sendLink}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <Textarea aria-label={text.reason} placeholder={text.reason} value={note} onChange={(e) => setNote(e.target.value)} data-testid={`document-review-note-${item.documentId}`} />
          <div className="flex gap-2">
            <Button size="sm" disabled={busy} onClick={() => void decide('APPROVED')} data-testid={`document-review-approve-${item.documentId}`}>{text.approve}</Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void decide('REJECTED')} data-testid={`document-review-reject-${item.documentId}`}>{text.reject}</Button>
          </div>
        </div>
      )}
      {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
      {message && <p className="text-sm text-green-700 dark:text-green-400" role="status">{message}</p>}
    </li>
  );
}
