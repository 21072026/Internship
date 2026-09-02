'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Search, Sparkles, ExternalLink, Users } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { useT } from '@/i18n/client';

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

// Premium talent-pool search (Faz 1). Shows a locked upsell when the company
// lacks the TALENT_POOL_SEARCH entitlement (API returns 403 feature_locked).
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
        <Card className="text-center py-12 max-w-lg mx-auto">
          <Sparkles className="h-12 w-12 text-blue-500 mx-auto mb-4" />
          <p className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">{tp.lockedTitle}</p>
          <p className="text-sm text-gray-500 max-w-sm mx-auto">{tp.lockedBody}</p>
        </Card>
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
