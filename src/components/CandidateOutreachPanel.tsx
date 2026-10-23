'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Check, X, MessageSquareOff } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';

// Company → candidate message requests on /messages (#1840). One panel, three
// views from the same GET: a mentor or admin sees the pending queue with the
// stored first message and decides; a candidate sees every company that may
// message them and can close the channel; a company sees its own requests and
// their status — never who decided or why. Renders nothing when there is
// nothing to show, so the inbox stays as it was for everyone else.

interface Row {
  id: string;
  status: string;
  company?: string;
  menteeName?: string;
  firstMessage?: string | null;
  conversationId?: string | null;
}

export function CandidateOutreachPanel({ role }: { role: string }) {
  const t = useT();
  const L = t.candidateOutreach;
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const res = await fetch('/api/company/outreach');
    if (res.ok) setRows((await res.json()).requests ?? []);
  }, []);
  useEffect(() => { load(); }, [load]);

  const act = async (id: string, action: 'approve' | 'decline' | 'revoke') => {
    setBusy(`${action}-${id}`);
    setError('');
    try {
      const res = await fetch(`/api/company/outreach/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) setError(t.common.error);
      await load();
    } finally {
      setBusy('');
    }
  };

  if (rows.length === 0) return null;
  const decider = role === 'MENTOR' || role === 'ADMIN';
  const title = decider ? L.queueTitle : role === 'MENTEE' ? L.channelsTitle : L.sentTitle;
  const hint = decider ? L.queueHint : role === 'MENTEE' ? L.channelsHint : L.sentHint;
  const statusLabel = (s: string) => (L.status as Record<string, string>)[s] ?? s;

  return (
    <Card className="mb-6" data-testid="outreach-panel">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{hint}</CardDescription>
      </CardHeader>
      <ul className="divide-y divide-gray-100 dark:divide-gray-800">
        {rows.map((r) => (
          <li key={r.id} className="py-3" data-testid={`outreach-${r.id}`}>
            {decider ? (
              <div className="space-y-2">
                <p className="text-sm text-gray-900 dark:text-gray-100">
                  {L.requestLine.replace('{company}', r.company ?? '').replace('{name}', r.menteeName ?? '')}
                </p>
                {r.firstMessage && (
                  <blockquote className="whitespace-pre-wrap break-words rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 dark:border-gray-700 dark:text-gray-300">
                    {r.firstMessage}
                  </blockquote>
                )}
                <div className="flex justify-end gap-2">
                  <Button size="sm" variant="outline" loading={busy === `decline-${r.id}`} onClick={() => act(r.id, 'decline')} data-testid={`outreach-decline-${r.id}`}>
                    <X className="mr-1 h-3.5 w-3.5" /> {L.decline}
                  </Button>
                  <Button size="sm" loading={busy === `approve-${r.id}`} onClick={() => act(r.id, 'approve')} data-testid={`outreach-approve-${r.id}`}>
                    <Check className="mr-1 h-3.5 w-3.5" /> {L.approve}
                  </Button>
                </div>
              </div>
            ) : role === 'MENTEE' ? (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0 text-sm text-gray-900 dark:text-gray-100">
                  {r.conversationId ? <Link href={`/messages/c/${r.conversationId}`} className="hover:underline">{r.company}</Link> : r.company}
                </div>
                <Button size="sm" variant="outline" loading={busy === `revoke-${r.id}`} onClick={() => act(r.id, 'revoke')} data-testid={`outreach-revoke-${r.id}`}>
                  <MessageSquareOff className="mr-1 h-3.5 w-3.5" /> {L.revoke}
                </Button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="text-gray-900 dark:text-gray-100">{r.menteeName}</span>
                <span className="text-gray-500" data-testid={`outreach-status-${r.id}`}>{statusLabel(r.status)}</span>
              </div>
            )}
          </li>
        ))}
      </ul>
      {error && <p className="mt-2 text-sm text-red-600" role="alert">{error}</p>}
      {role === 'MENTEE' && <p className="mt-2 text-xs text-gray-500">{L.revokeNote}</p>}
    </Card>
  );
}
