'use client';

import { useCallback, useEffect, useState } from 'react';
import { Inbox } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useT } from '@/i18n/client';
import { formatMentorAvailability } from '@/lib/mentorAvailabilityLabel';
import type { MentorAvailability } from '@/lib/mentorAvailability';

interface RequestRow {
  id: string;
  message?: string | null;
  targetPosition?: string | null;
  createdAt: string;
  mentee: { id: string; fullName: string; email: string; university?: string | null; skills: string[] };
}

interface MentorOption {
  id: string;
  fullName: string;
  // Capacity/availability (#942) — optional so a caller with only a bare
  // {id, fullName} picker still satisfies this type; the label/confirmation
  // gate are simply skipped for those. The one real caller today
  // (/admin/mentorship) already fetches these via
  // /api/users?view=mentorAvailability, same list it feeds the direct-assign
  // pickers, so no extra request is made here.
  mentorCapacity?: number | null;
  activeMenteeCount?: number;
  availability?: MentorAvailability;
}

// Admin queue for mentee mentorship requests (#590). Hidden while empty.
export function MentorshipRequestQueue({ mentors, onApproved }: {
  mentors: MentorOption[];
  onApproved: () => void;
}) {
  const t = useT();
  const q = t.mentorshipRequests;
  const a = t.assignMentor;
  const [rows, setRows] = useState<RequestRow[]>([]);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState('');
  // Approval held for confirmation (#942) when the picked mentor's server-
  // reported availability.status is at_capacity/not_accepting — same gate as
  // the direct-assignment flows, reusing their ConfirmDialog copy.
  const [pendingApprove, setPendingApprove] = useState<{ requestId: string; status: 'at_capacity' | 'not_accepting' } | null>(null);

  const load = useCallback(() => {
    fetch('/api/admin/mentorship-requests')
      .then((r) => (r.ok ? r.json() : { requests: [] }))
      .then((d) => setRows(d.requests ?? []))
      .catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  // Does the actual PUT — called either directly (reject, or approve of an
  // available mentor) or after the confirmation dialog is accepted. The
  // response's `warnings` (#942) are accepted defensively and otherwise
  // ignored: the confirmation already happened client-side before this ran,
  // so a second dialog off the same warning would just be a duplicate.
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

  // Entry point for the "Approve" button. Gates on the chosen mentor's
  // availability.status from the server — never recomputed here — and only
  // interrupts with a dialog for at_capacity/not_accepting; an available
  // mentor (or one with no availability info at all) is approved
  // immediately, same as before #942.
  const approve = (requestId: string) => {
    const mentorId = choices[requestId];
    if (!mentorId) return;
    const status = mentors.find((m) => m.id === mentorId)?.availability?.status;
    if (status === 'at_capacity' || status === 'not_accepting') {
      setPendingApprove({ requestId, status });
      return;
    }
    decide(requestId, 'approve');
  };

  const confirmApprove = () => {
    if (!pendingApprove) return;
    const { requestId } = pendingApprove;
    setPendingApprove(null);
    decide(requestId, 'approve');
  };

  if (rows.length === 0) return null;

  return (
    <>
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
                  <option key={m.id} value={m.id}>
                    {/* Full or paused mentors stay selectable (#942) — the
                        label is advisory, never a restriction. */}
                    {m.availability
                      ? `${m.fullName} · ${formatMentorAvailability(
                          { mentorCapacity: m.mentorCapacity ?? null, activeMenteeCount: m.activeMenteeCount ?? 0, availability: m.availability },
                          t.mentorAvailability
                        )}`
                      : m.fullName}
                  </option>
                ))}
              </select>
              <Button size="sm" loading={busy === r.id} disabled={!choices[r.id]} onClick={() => approve(r.id)}>
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
    <ConfirmDialog
      open={pendingApprove !== null}
      message={pendingApprove?.status === 'at_capacity' ? a.confirmAtCapacity : a.confirmNotAccepting}
      cancelLabel={t.common.cancel}
      confirmLabel={a.confirmAnyway}
      loading={busy === pendingApprove?.requestId}
      onConfirm={confirmApprove}
      onCancel={() => setPendingApprove(null)}
    />
    </>
  );
}
