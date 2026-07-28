'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Send, Clock, CheckCircle2, XCircle, ListChecks } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Textarea';
import { useT } from '@/i18n/client';

interface Gate { profile: boolean; cv: boolean; complete: boolean; missing: ('profile' | 'cv')[] }

interface RequestRow {
  id: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  message?: string | null;
  createdAt: string;
  decidedAt?: string | null;
}

// Mentee-side "request a mentor" panel (#590), shown on the portal dashboard
// while the mentee has no active mentorship. One PENDING request at a time;
// the latest decision stays visible.
export function MentorshipRequestPanel() {
  const t = useT();
  const q = t.mentorshipRequests;
  const [requests, setRequests] = useState<RequestRow[] | null>(null);
  const [gate, setGate] = useState<Gate | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = () =>
    fetch('/api/mentorship-requests')
      .then((r) => (r.ok ? r.json() : { requests: [] }))
      .then((d) => { setRequests(d.requests ?? []); setGate(d.gate ?? null); })
      .catch(() => setRequests([]));

  useEffect(() => { load(); }, []);

  if (!requests) return null;
  const pending = requests.find((r) => r.status === 'PENDING');
  const latest = requests[0];

  const submit = async () => {
    setBusy(true);
    setErr('');
    try {
      const res = await fetch('/api/mentorship-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: message.trim() || undefined }),
      });
      if (res.ok) {
        setMessage('');
        await load();
      } else {
        const d = await res.json().catch(() => ({}));
        if (d.code === 'rate_limited') setErr(q.rateLimited);
        else if (d.code === 'already_pending') setErr(q.alreadyPending);
        else setErr(d.error || t.common.error);
      }
    } catch {
      setErr(t.common.error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="mb-6" data-testid="mentorship-request">
      <CardHeader><CardTitle>{q.title}</CardTitle></CardHeader>
      {pending ? (
        <p className="text-sm text-amber-700 dark:text-amber-400 flex items-center gap-2" data-testid="request-pending">
          <Clock className="h-4 w-4" /> {q.pendingInfo}
        </p>
      ) : (
        <>
          {latest?.status === 'APPROVED' && (
            <p className="text-sm text-green-700 dark:text-green-400 flex items-center gap-2 mb-3">
              <CheckCircle2 className="h-4 w-4" /> {q.approvedInfo}
            </p>
          )}
          {latest?.status === 'REJECTED' && (
            <p className="text-sm text-gray-600 dark:text-gray-300 flex items-center gap-2 mb-3">
              <XCircle className="h-4 w-4" /> {q.rejectedInfo}
            </p>
          )}
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">{q.hint}</p>
          <Textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={q.messagePlaceholder}
            rows={3}
            maxLength={2000}
            showCounter
            className="mb-2"
          />
          {err && <p className="text-xs text-red-600 mb-2">{err}</p>}
          {gate && !gate.complete && (
            <div className="mb-2 rounded-lg bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-800 p-3" data-testid="request-gate">
              <p className="text-xs font-medium text-amber-800 dark:text-amber-300 flex items-center gap-1.5 mb-1">
                <ListChecks className="h-4 w-4" /> {q.gateTitle}
              </p>
              <ul className="text-xs text-amber-700 dark:text-amber-400 list-disc list-inside">
                {gate.missing.includes('profile') && (
                  <li><Link href="/portal/profile" className="underline">{q.gateProfile}</Link></li>
                )}
                {gate.missing.includes('cv') && (
                  <li><Link href="/portal/profile" className="underline">{q.gateCv}</Link></li>
                )}
              </ul>
            </div>
          )}
          <Button type="button" loading={busy} disabled={!!gate && !gate.complete} onClick={submit} data-testid="request-submit">
            <Send className="h-4 w-4 mr-1" /> {q.submit}
          </Button>
        </>
      )}
    </Card>
  );
}
