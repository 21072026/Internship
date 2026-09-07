'use client';

import { useCallback, useEffect, useState } from 'react';
import { Inbox, Repeat2 } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useT } from '@/i18n/client';
import { mentorshipAssignmentError } from '@/lib/mentorshipAssignmentError';
import { formatMentorAvailability } from '@/lib/mentorAvailabilityLabel';
import type { MentorAvailability } from '@/lib/mentorAvailability';
import { PersonHoverCard } from '@/components/PersonHoverCard';

interface RequestRow {
  id: string;
  message?: string | null;
  targetPosition?: string | null;
  // Matching preferences (#939) — advisory hints from the mentee; the
  // preferred mentor merely preselects the picker below, never binds it.
  preferredField?: string | null;
  preferredLanguages?: unknown; // JSON column — guarded with Array.isArray
  preferredMentor?: { id: string; fullName: string } | null;
  createdAt: string;
  mentee: { id: string; fullName: string; email: string; university?: string | null; skills: string[] };
  // Re-match (#1801). Set when this request asks to REPLACE a live pairing.
  // `rematchReason`/`rematchNote` reach this component and nowhere else: the
  // admin queue is the only read path for them, and the outgoing mentor —
  // shown here as `replacesRelation.mentor` — is never told either.
  replacesRelationId?: string | null;
  rematchReason?: string | null;
  rematchNote?: string | null;
  replacesRelation?: { id: string; startDate: string; mentor: { id: string; fullName: string } } | null;
}

/** Programme-health counts returned alongside the queue (#1801). */
interface RematchStats {
  days: number;
  rematched: number;
  ended: number;
  byReason: Record<string, number>;
}

type Filter = 'all' | 'rematch' | 'new';

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
  const rm = t.rematchRequest;
  const a = t.assignMentor;
  const [rows, setRows] = useState<RequestRow[]>([]);
  const [stats, setStats] = useState<RematchStats | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
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
      .then((d) => { setRows(d.requests ?? []); setStats(d.rematchStats ?? null); })
      .catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  // Preselect the mentee's preferred mentor (#939) — non-binding: it only
  // fills a select the admin has not touched yet, and only when that mentor
  // is actually in the passed list. The admin can still pick anyone.
  useEffect(() => {
    setChoices((c) => {
      let changed = false;
      const next = { ...c };
      for (const r of rows) {
        const preferred = r.preferredMentor;
        if (preferred && next[r.id] === undefined && mentors.some((m) => m.id === preferred.id)) {
          next[r.id] = preferred.id;
          changed = true;
        }
      }
      return changed ? next : c;
    });
  }, [rows, mentors]);

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
        // The approval path answers `already_mentored` (#419), `already_decided`,
        // `invalid_mentor` and the plan gate's `plan_limit_reached`; all four
        // used to arrive here as the server's English literal, and then all but
        // the first collapsed into the generic line. Anything unrecognised
        // still falls back to it rather than publishing whatever text a route
        // happens to carry (#2283 follow-up).
        setErr(mentorshipAssignmentError(t, d, t.common.error));
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

  // The server already sorted re-matches to the top; this only narrows.
  const rematchCount = rows.filter((r) => r.replacesRelationId).length;
  const visible = rows.filter((r) =>
    filter === 'all' ? true : filter === 'rematch' ? !!r.replacesRelationId : !r.replacesRelationId
  );
  const filters: { key: Filter; label: string; count: number }[] = [
    { key: 'all', label: rm.filterAll, count: rows.length },
    { key: 'rematch', label: rm.filterRematch, count: rematchCount },
    { key: 'new', label: rm.filterNew, count: rows.length - rematchCount },
  ];

  return (
    <>
    <Card className="mb-6 border-blue-200 dark:border-blue-800" data-testid="request-queue">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Inbox className="h-5 w-5 text-blue-600" />
          <CardTitle>{q.queueTitle} ({rows.length})</CardTitle>
        </div>
      </CardHeader>
      {rematchCount > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-1.5" data-testid="request-queue-filters">
          {filters.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              data-testid={`request-queue-filter-${f.key}`}
              aria-pressed={filter === f.key}
              className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                filter === f.key
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300'
              }`}
            >
              {f.label} ({f.count})
            </button>
          ))}
        </div>
      )}
      {/* Programme health, not an embarrassment to hide (#1801): how many
          pairings that ended in the window ended because the mentee asked for
          somebody else, and for which stated reasons. A re-match is never
          counted as a completion anywhere. */}
      {stats && stats.rematched > 0 && (
        <p className="mb-3 text-xs text-gray-600 dark:text-gray-400" data-testid="rematch-stats">
          {rm.statsSummary
            .replace('{count}', String(stats.rematched))
            .replace('{total}', String(stats.ended))
            .replace('{days}', String(stats.days))}
          {Object.keys(stats.byReason).length > 0 && (
            <span>
              {' · '}
              {Object.entries(stats.byReason)
                .map(([code, n]) => `${rm.reasons[code as keyof typeof rm.reasons] ?? code}: ${n}`)
                .join(' · ')}
            </span>
          )}
        </p>
      )}
      {err && <p className="text-sm text-red-600 mb-2">{err}</p>}
      <div className="divide-y divide-gray-50 dark:divide-gray-800">
        {visible.map((r) => {
          const preferredLanguages = Array.isArray(r.preferredLanguages)
            ? (r.preferredLanguages as unknown[]).map((l) => String(l))
            : [];
          return (
          <div key={r.id} data-testid={`request-${r.id}`} className="py-3 flex flex-col lg:flex-row lg:items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                {r.replacesRelationId && (
                  <span
                    className="mr-2 inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800"
                    data-testid="rematch-badge"
                  >
                    <Repeat2 className="h-3 w-3" /> {rm.badge}
                  </span>
                )}
                <PersonHoverCard personId={r.mentee.id} name={r.mentee.fullName} role="MENTEE" />
                {r.targetPosition && <span className="text-xs text-gray-500 ml-2">→ {r.targetPosition}</span>}
              </p>
              <p className="text-xs text-gray-500 truncate">{r.mentee.email}{r.mentee.university ? ` · ${r.mentee.university}` : ''}</p>
              {r.message && <p className="text-sm text-gray-600 dark:text-gray-300 mt-1 whitespace-pre-line">{r.message}</p>}
              {/* The re-match detail: who they are with today, why they asked
                  and anything they wrote. This block is the ONLY place the
                  reason and the note are ever rendered — the outgoing mentor is
                  told the pairing ended and nothing more. */}
              {r.replacesRelationId && (
                <div
                  className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800"
                  data-testid={`rematch-detail-${r.id}`}
                >
                  {r.replacesRelation && (
                    <p>
                      {rm.currentMentor}:{' '}
                      <PersonHoverCard
                        personId={r.replacesRelation.mentor.id}
                        name={r.replacesRelation.mentor.fullName}
                        role="MENTOR"
                      />
                    </p>
                  )}
                  {r.rematchReason && (
                    <p className="mt-0.5" data-testid="rematch-reason-label">
                      {rm.reasonLabel}:{' '}
                      {rm.reasons[r.rematchReason as keyof typeof rm.reasons] ?? r.rematchReason}
                    </p>
                  )}
                  {r.rematchNote && <p className="mt-0.5 whitespace-pre-line">{r.rematchNote}</p>}
                  <p className="mt-1 text-[11px] text-amber-700">{rm.adminPrivacyHint}</p>
                </div>
              )}
              {(r.preferredField || preferredLanguages.length > 0 || r.preferredMentor) && (
                <div className="flex flex-wrap gap-1.5 mt-1.5" data-testid="request-preferences">
                  {r.preferredField && (
                    <span className="inline-flex items-center rounded-full bg-gray-100 dark:bg-gray-800 px-2 py-0.5 text-xs text-gray-700 dark:text-gray-300">
                      {q.prefField}: {r.preferredField}
                    </span>
                  )}
                  {preferredLanguages.length > 0 && (
                    <span className="inline-flex items-center rounded-full bg-gray-100 dark:bg-gray-800 px-2 py-0.5 text-xs text-gray-700 dark:text-gray-300">
                      {q.prefLanguages}: {preferredLanguages.join(', ')}
                    </span>
                  )}
                  {r.preferredMentor && (
                    <span className="inline-flex items-center rounded-full bg-gray-100 dark:bg-gray-800 px-2 py-0.5 text-xs text-gray-700 dark:text-gray-300">
                      {q.prefMentor}:{' '}
                      <PersonHoverCard personId={r.preferredMentor.id} name={r.preferredMentor.fullName} role="MENTOR" />
                    </span>
                  )}
                </div>
              )}
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
          );
        })}
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
