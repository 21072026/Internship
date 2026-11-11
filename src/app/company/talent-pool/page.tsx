'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Search, ExternalLink, Users } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { useT } from '@/i18n/client';
import { UpgradePrompt } from '@/components/UpgradePrompt';

type IntroStatus = 'PENDING' | 'APPROVED' | 'DECLINED' | 'CLOSED';

interface Candidate {
  id: string;
  fullName: string;
  university?: string | null;
  department?: string | null;
  graduationYear?: number | null;
  city?: string | null;
  targetPosition?: string | null;
  skills: string[];
  avatarUrl?: string | null;
}

// Premium talent-pool search (Faz 1). Shows the shared upgrade prompt (#1745)
// when the company lacks the TALENT_POOL_SEARCH entitlement (403 feature_locked).
const PAGE_SIZE = 24;

export default function TalentPoolPage() {
  const t = useT();
  const tp = t.talentPool;
  const [q, setQ] = useState('');
  const [skill, setSkill] = useState('');
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [locked, setLocked] = useState(false);
  // The endpoint used to return an unpaginated, silently truncated list (#1392).
  // `total` is now the count of the whole matching set, so the page can say how
  // many results there are rather than implying the screen is all of them.
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  // Introduction requests already made (#1394): menteeId → status, from the
  // company's own request list — the server's answer, never a guess.
  const [intros, setIntros] = useState<Record<string, IntroStatus>>({});
  const loadIntros = useCallback(async () => {
    const res = await fetch('/api/company/outreach').catch(() => null);
    if (!res?.ok) return;
    const d = await res.json().catch(() => null);
    const map: Record<string, IntroStatus> = {};
    for (const r of (d?.requests ?? []) as { menteeId: string; status: IntroStatus }[]) map[r.menteeId] = r.status;
    setIntros(map);
  }, []);
  useEffect(() => { void loadIntros(); }, [loadIntros]);
  const hasFilters = Boolean(q.trim() || skill.trim());
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (skill) params.set('skill', skill);
      params.set('page', String(page));
      params.set('pageSize', String(PAGE_SIZE));
      const res = await fetch(`/api/company/talent-pool?${params.toString()}`);
      if (res.status === 403) { setLocked(true); return; }
      const d = await res.json();
      setLocked(false);
      setCandidates(d.candidates ?? []);
      setTotal(typeof d.total === 'number' ? d.total : (d.candidates?.length ?? 0));
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [q, skill, page]);

  // Any filter change goes back to page 1. Without this, retyping a filter while
  // on page 3 asks for page 3 of a smaller result set and renders an empty grid
  // — which looks exactly like the bug this change fixes.
  useEffect(() => { setPage(1); }, [q, skill]);

  // Debounce searches; initial load on mount.
  useEffect(() => {
    const timer = setTimeout(load, 300);
    return () => clearTimeout(timer);
  }, [load]);

  if (locked) {
    return (
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-1">{tp.title}</h1>
        <p className="text-gray-500 mb-6">{tp.subtitle}</p>
        <UpgradePrompt gate={{ code: 'feature_locked', feature: 'TALENT_POOL_SEARCH' }} viewer="company" audience="EMPLOYER" className="max-w-lg mx-auto" />
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{tp.title}</h1>
        <p className="text-gray-500 mt-1">{tp.subtitle}</p>
      </div>

      <div className="flex flex-col sm:flex-row gap-3 mb-6">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            data-testid="talent-pool-search"
            placeholder={tp.searchPlaceholder}
            className="pl-10 w-full rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-800 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400"
          />
        </div>
        <input
          type="text"
          value={skill}
          onChange={(e) => setSkill(e.target.value)}
          data-testid="talent-pool-skill"
          placeholder={tp.skillPlaceholder}
          className="sm:w-56 rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-800 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400"
        />
      </div>

      {loading ? (
        <Card><SkeletonRows rows={4} /></Card>
      ) : candidates.length === 0 ? (
        <Card
          data-testid="talent-pool-empty-state"
          data-empty-kind={hasFilters ? 'no-results' : 'empty-pool'}
        >
          <EmptyState
            testId={hasFilters ? 'talent-pool-filtered' : 'talent-pool'}
            icon={hasFilters ? Search : Users}
            title={hasFilters ? tp.noResultsTitle : tp.emptyTitle}
            body={hasFilters ? tp.noResultsDescription : tp.emptyDescription}
            action={hasFilters ? { label: tp.clearFilters, onClick: () => { setQ(''); setSkill(''); } } : undefined}
          />
        </Card>
      ) : (
        <>
        <p data-testid="talent-pool-total" className="mb-3 text-sm text-gray-600 dark:text-gray-300">
          {tp.showing
            .replace('{from}', String((page - 1) * PAGE_SIZE + 1))
            .replace('{to}', String(Math.min(page * PAGE_SIZE, total)))
            .replace('{total}', String(total))}
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {candidates.map((c) => (
            <Card key={c.id}>
              <div className="flex items-start gap-3">
                <div className="w-11 h-11 rounded-xl bg-blue-100 dark:bg-blue-900/40 flex items-center justify-center flex-shrink-0">
                  <span className="text-blue-700 dark:text-blue-300 font-bold">{c.fullName?.[0] ?? '?'}</span>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-gray-900 dark:text-gray-100 truncate">{c.fullName}</p>
                  {c.targetPosition && <p className="text-xs text-blue-600 dark:text-blue-400 truncate">{c.targetPosition}</p>}
                  <p className="text-xs text-gray-500 truncate">
                    {[c.university, c.department].filter(Boolean).join(' · ')}
                    {c.graduationYear ? ` · ${c.graduationYear}` : ''}
                  </p>
                </div>
              </div>
              {c.skills.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-3">
                  {c.skills.slice(0, 6).map((s) => (
                    <Badge key={s} variant="info" className="text-xs">{s}</Badge>
                  ))}
                </div>
              )}
              <Link
                href={`/p/${c.id}`}
                target="_blank"
                className="inline-flex items-center gap-1 text-sm text-blue-600 dark:text-blue-400 hover:underline mt-3"
              >
                <ExternalLink className="h-3.5 w-3.5" /> {tp.viewProfile}
              </Link>
              <IntroRequest menteeId={c.id} status={intros[c.id]} onSent={loadIntros} />
            </Card>
          ))}
        </div>
        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-3 mt-6">
            <button
              type="button"
              data-testid="talent-pool-prev"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-1.5 text-sm text-gray-700 dark:text-gray-200 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {t.common.prev}
            </button>
            <span className="text-sm text-gray-600 dark:text-gray-300" data-testid="talent-pool-page">
              {page} / {totalPages}
            </span>
            <button
              type="button"
              data-testid="talent-pool-next"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className="rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-1.5 text-sm text-gray-700 dark:text-gray-200 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {t.common.next}
            </button>
          </div>
        )}
        </>
      )}
    </div>
  );
}

// Ask to be introduced to a pool candidate (#1394). The request is stored and
// goes to the candidate's mentor (or the programme's admins) to approve; nothing
// reaches the candidate — and no contact detail reaches the company — before that.
function IntroRequest({ menteeId, status, onSent }: { menteeId: string; status?: IntroStatus; onSent: () => void }) {
  const t = useT();
  const ti = t.talentPool.intro;
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A declined request may be asked again; any other standing state is shown.
  if (status && status !== 'DECLINED') {
    return (
      <p className="mt-3 text-sm text-gray-600 dark:text-gray-300" data-testid={`talent-pool-intro-status-${menteeId}`}>
        {ti.status[status]}
      </p>
    );
  }

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/company/outreach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ menteeId, message, via: 'TALENT_POOL' }),
      });
      if (res.ok) {
        setOpen(false);
        setMessage('');
        onSent();
        return;
      }
      const d = await res.json().catch(() => null);
      const code = typeof d?.code === 'string' ? d.code : '';
      setError((ti.errors as Record<string, string>)[code] ?? ti.errors.generic);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <div className="mt-3">
        {status === 'DECLINED' && <p className="text-xs text-gray-500 mb-1">{ti.status.DECLINED}</p>}
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-sm font-medium text-blue-600 dark:text-blue-400 hover:underline"
          data-testid={`talent-pool-intro-open-${menteeId}`}
        >
          {ti.request}
        </button>
      </div>
    );
  }

  return (
    <div className="mt-3 space-y-2">
      <label htmlFor={`intro-${menteeId}`} className="block text-sm font-medium text-gray-700 dark:text-gray-200">{ti.messageLabel}</label>
      <textarea
        id={`intro-${menteeId}`}
        rows={3}
        maxLength={2000}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm"
        data-testid={`talent-pool-intro-message-${menteeId}`}
      />
      <p className="text-xs text-gray-500">{ti.hint}</p>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy || !message.trim()}
          onClick={send}
          className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          data-testid={`talent-pool-intro-send-${menteeId}`}
        >
          {ti.send}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="rounded-lg px-3 py-1.5 text-sm text-gray-600 dark:text-gray-300">
          {t.common.cancel}
        </button>
      </div>
    </div>
  );
}
