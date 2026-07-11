'use client';

import { useCallback, useEffect, useState } from 'react';
import { Inbox } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';

interface RequestRow {
  id: string;
  message?: string | null;
  targetPosition?: string | null;
  createdAt: string;
  mentee: { id: string; fullName: string; email: string; university?: string | null; skills: string[] };
}

// Admin queue for mentee mentorship requests (#590). Hidden while empty.
export function MentorshipRequestQueue({ mentors, onApproved }: {
  mentors: { id: string; fullName: string }[];
  onApproved: () => void;
}) {
  const t = useT();
  const q = t.mentorshipRequests;
  const [rows, setRows] = useState<RequestRow[]>([]);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState('');

  const load = useCallback(() => {
    fetch('/api/admin/mentorship-requests')
      .then((r) => (r.ok ? r.json() : { requests: [] }))
      .then((d) => setRows(d.requests ?? []))
      .catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  const decide = async (requestId: string, action: 'approve' | 'reject') => {
    setBusy(requestId);
    setErr('');
    try {
      const res = await fetch('/api/admin/mentorship-requests', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, action, mentorId: choices[requestId] || undefined }),
      });
      if (res.ok) {
        load();
        if (action === 'approve') onApproved();
      } else {
        const d = await res.json().catch(() => ({}));
        setErr(d.error || t.common.error);
      }
    } catch {
      setErr(t.common.error);
    } finally {
      setBusy(null);
    }
  };

  if (rows.length === 0) return null;

  return (
    <Card className="mb-6 border-blue-200 dark:border-blue-800" data-testid="request-queue">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Inbox className="h-5 w-5 text-blue-600" />
          <CardTitle>{q.queueTitle} ({rows.length})</CardTitle>
        </div>
      </CardHeader>
      {err && <p className="text-sm text-red-600 mb-2">{err}</p>}
      <div className="divide-y divide-gray-50 dark:divide-gray-800">
        {rows.map((r) => (
          <div key={r.id} data-testid={`request-${r.id}`} className="py-3 flex flex-col lg:flex-row lg:items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                {r.mentee.fullName}
                {r.targetPosition && <span className="text-xs text-gray-500 ml-2">→ {r.targetPosition}</span>}
              </p>
              <p className="text-xs text-gray-500 truncate">{r.mentee.email}{r.mentee.university ? ` · ${r.mentee.university}` : ''}</p>
              {r.message && <p className="text-sm text-gray-600 dark:text-gray-300 mt-1 whitespace-pre-line">{r.message}</p>}
            </div>
            <div className="flex flex-wrap items-center gap-2 flex-shrink-0">
              <select
                value={choices[r.id] ?? ''}
                onChange={(e) => setChoices((c) => ({ ...c, [r.id]: e.target.value }))}
                aria-label={q.chooseMentor}
                className="rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-800 px-2.5 py-1.5 text-sm"
              >
                <option value="">{q.chooseMentor}</option>
                {mentors.map((m) => (
                  <option key={m.id} value={m.id}>{m.fullName}</option>
                ))}
              </select>
              <Button size="sm" loading={busy === r.id} disabled={!choices[r.id]} onClick={() => decide(r.id, 'approve')}>
                {q.approve}
              </Button>
              <Button size="sm" variant="outline" loading={busy === r.id} onClick={() => decide(r.id, 'reject')}>
                {q.reject}
              </Button>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
