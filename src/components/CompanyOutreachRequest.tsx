'use client';

import { useEffect, useState } from 'react';
import { Send } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';
import { MAX_FIRST_MESSAGE } from '@/lib/outreachRule';

// A company's "ask to message this candidate" (#1840) on the candidate page.
// The server decides everything — shortlisted, consented, quota, cooldown —
// and this card only shows its answer. The message waits for the candidate's
// mentor or an admin; it is not delivered until approved.

export function CompanyOutreachRequest({ menteeId }: { menteeId: string }) {
  const t = useT();
  const L = t.candidateOutreach;
  const [status, setStatus] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Collapsed until asked for: the composer is a deliberate step, and the page
  // already carries the shortlist note's textarea.
  const [composing, setComposing] = useState(false);

  useEffect(() => {
    fetch('/api/company/outreach')
      .then((r) => (r.ok ? r.json() : { requests: [] }))
      .then((j) => setStatus(j.requests?.find((r: { menteeId: string }) => r.menteeId === menteeId)?.status ?? null))
      .catch(() => {});
  }, [menteeId]);

  const send = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/company/outreach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ menteeId, message }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        setStatus('PENDING');
        setMessage('');
        setComposing(false);
        return;
      }
      const known: Record<string, string> = {
        not_shortlisted: L.errNotShortlisted,
        no_consent: L.errNoConsent,
        pending: L.errPending,
        already_approved: L.errApproved,
        cooldown: L.errCooldown,
        quota_exceeded: L.errQuota.replace('{used}', String(body.used ?? '')).replace('{limit}', String(body.limit ?? '')),
      };
      setError((body.code && known[body.code]) || t.common.error);
    } finally {
      setBusy(false);
    }
  };

  const open = status === null || status === 'DECLINED' || status === 'CLOSED';
  return (
    <Card className="mt-4" data-testid="outreach-request-card">
      <CardHeader>
        <CardTitle>{L.requestTitle}</CardTitle>
        <CardDescription>{L.requestHint}</CardDescription>
      </CardHeader>
      {status && <p className="mb-2 text-sm text-gray-600 dark:text-gray-300" data-testid="outreach-request-status">{(L.status as Record<string, string>)[status] ?? status}</p>}
      {open && !composing && (
        <Button size="sm" variant="outline" onClick={() => setComposing(true)} data-testid="outreach-compose">
          <Send className="mr-1 h-3.5 w-3.5" /> {L.compose}
        </Button>
      )}
      {open && composing && (
        <div className="space-y-2">
          <textarea
            className="block w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
            rows={4}
            maxLength={MAX_FIRST_MESSAGE}
            placeholder={L.messagePlaceholder}
            aria-label={L.messagePlaceholder}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            data-testid="outreach-message"
          />
          <div className="flex justify-end">
            <Button size="sm" disabled={!message.trim()} loading={busy} onClick={send} data-testid="outreach-send">
              <Send className="mr-1 h-3.5 w-3.5" /> {L.send}
            </Button>
          </div>
        </div>
      )}
      {error && <p className="mt-2 text-sm text-red-600" role="alert" data-testid="outreach-error">{error}</p>}
    </Card>
  );
}
