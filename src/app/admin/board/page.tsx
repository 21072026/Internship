'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { GraduationCap, User, LayoutGrid } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { groupResolvedStages } from '@/lib/pipeline';
import { useResolvedStages, useStageLabel } from '@/lib/pipelineStagesClient';
import { useT } from '@/i18n/client';
import { useToast } from '@/components/ui/Toast';
import { useIsNarrow } from '@/hooks/useIsNarrow';
import { useFilterAnnouncement } from '@/hooks/useFilterAnnouncement';
import { BoardStageFilter } from '@/components/board/BoardStageFilter';
import { CardStageSelect } from '@/components/board/CardStageSelect';
import { BoardPhaseGroups } from '@/components/board/BoardPhaseGroups';
import { BoardColumnHeader } from '@/components/board/BoardColumnHeader';
import { OverdueBadge } from '@/components/board/OverdueBadge';
import { useBoardFilters } from '@/components/board/useBoardFilters';
import { useBoardWipLimits } from '@/components/board/useBoardWipLimits';
import { DropoffReasonDialog } from '@/components/DropoffReasonDialog';
import { PersonHoverCard } from '@/components/PersonHoverCard';
import { isStageOverdue } from '@/lib/stageClock';
import { FollowUpChip } from '@/components/FollowUpPanel';
import { TrialEndChip } from '@/components/TrialEndPanel';
import { SavedViews } from '@/components/SavedViews';
import { isWipSaturated, type WipColumn } from '@/lib/boardWip';
import { HelpTip } from '@/components/guidance/HelpTip';

interface Relation {
  id: string;
  pipelineStatus: string;
  stageDeadline?: string | null;
  // Served by GET /api/mentorship since #1724: the mentee sits in the
  // re-engagement pool, so this card can never read as a breach — the same
  // exclusion the admin aging report applies to its own overdue list.
  stageClockPaused?: boolean;
  // The owner's follow-up date (#2563), shipped to the owner and ADMIN only.
  nextActionAt?: string | null;
  // The trial end (#2553): a chip on a trial-stage card, or the "date missing" badge.
  trialEndsAt?: string | null;
  mentee: { id: string; fullName: string; university?: string };
  mentor: { id: string; fullName: string };
  _count: { interactions: number };
}

// Admin kanban across ALL mentorship relations (every mentor's mentees).
// Stages are grouped into three collapsible phases so 13 columns don't sprawl.
export default function AdminBoardPage() {
  const t = useT();
  const stages = useResolvedStages();
  const label = useStageLabel();
  const router = useRouter();
  const toast = useToast();
  const narrow = useIsNarrow();
  const [relations, setRelations] = useState<Relation[]>([]);
  // Work-in-progress limits (#1439). Was a hardcoded 8 here, which every column
  // of a large pipeline breached — so the limit is configuration now: the
  // org-wide `boardWipLimit` setting, overridable per stage, and switchable off.
  // The rule that combines them lives in src/lib/boardWip.ts.
  const resolvedWipLimit = useBoardWipLimits();
  // moveTo is also called much later from a toast's "Undo", where the closed-over
  // `relations` would be stale — read the live list through a ref instead.
  const relationsRef = useRef<Relation[]>([]);
  // Each column's TRUE size (#1438): the board holds only the first page of
  // every column, so the header counts, the WIP chips and the phone filter read
  // these, never the number of cards loaded.
  const [counts, setCounts] = useState<Record<string, number>>({});
  const countsRef = useRef<Record<string, number>>({});
  const [pagesLoaded, setPagesLoaded] = useState<Record<string, number>>({});
  const [loadingMore, setLoadingMore] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const { search, setSearch, hideEmpty, setHideEmpty } = useBoardFilters();
  const [mobileStage, setMobileStage] = useState('');
  // The groups the VIEWER actually has (#828) — built from the resolved stages,
  // so a customized pipeline is not silently dropped on the desktop board.
  const groups = useMemo(() => groupResolvedStages(stages), [stages]);

  // The search runs on the server (#1438) — a client-side filter would only
  // search the cards that happen to be loaded. Debounced; the cards already on
  // screen are still filtered in place while it settles.
  const [serverSearch, setServerSearch] = useState(search.trim());
  useEffect(() => {
    const id = setTimeout(() => setServerSearch(search.trim()), 250);
    return () => clearTimeout(id);
  }, [search]);

  const boardUrl = useCallback(
    (extra: Record<string, string> = {}) => {
      const params = new URLSearchParams({ view: 'board', ...extra });
      if (serverSearch) params.set('search', serverSearch);
      return `/api/mentorship?${params}`;
    },
    [serverSearch]
  );

  const fetchRelations = useCallback(async () => {
    const res = await fetch(boardUrl());
    const data = await res.json();
    setRelations(data.relations ?? []);
    setCounts(data.counts ?? {});
    setPagesLoaded({});
    setLoading(false);
  }, [boardUrl]);

  // One more page of one column, appended without duplicates (a card moved in
  // meanwhile may already be on screen).
  const loadMore = async (stage: string) => {
    setLoadingMore(stage);
    try {
      const page = (pagesLoaded[stage] ?? 1) + 1;
      const res = await fetch(boardUrl({ stage, page: String(page) }));
      if (!res.ok) throw new Error('Failed');
      const data = await res.json();
      setRelations((rs) => {
        const seen = new Set(rs.map((r) => r.id));
        return [...rs, ...((data.relations ?? []) as Relation[]).filter((r) => !seen.has(r.id))];
      });
      setPagesLoaded((p) => ({ ...p, [stage]: page }));
    } catch {
      toast(t.board.loadMoreFailed, 'error');
    } finally {
      setLoadingMore(null);
    }
  };

  useEffect(() => {
    relationsRef.current = relations;
  }, [relations]);

  useEffect(() => {
    countsRef.current = counts;
  }, [counts]);

  useEffect(() => {
    fetchRelations();
  }, [fetchRelations]);

  // Pin the phone filter to a real stage once data is in: deriving it on every
  // render made the view follow a card to its new stage, so you never saw it
  // leave the stage you were looking at.
  useEffect(() => {
    if (mobileStage || loading || stages.length === 0) return;
    const firstWithItems = stages.find((s) => (counts[s.key] ?? 0) > 0);
    setMobileStage(firstWithItems?.key ?? stages[0].key);
  }, [mobileStage, loading, stages, counts]);

  // `silent` suppresses the undo offer, so undoing a move can't offer to undo itself.
  // reasonCode/reasonNote (#810): required server-side when pipelineStatus is a
  // negative/off-path stage — requestMove() below gates that before calling here.
  // Undo intentionally does NOT collect a reason even when it lands back on a
  // negative stage; the server still enforces the rule, so a reason-less undo
  // into a negative stage fails safely (reverted + error toast) rather than
  // silently bypassing validation.
  const moveTo = async (relationId: string, pipelineStatus: string, opts?: { silent?: boolean; reasonCode?: string; reasonNote?: string }) => {
    const prev = relationsRef.current;
    const prevCounts = countsRef.current;
    const from = prev.find((r) => r.id === relationId)?.pipelineStatus;
    if (from === pipelineStatus) return;
    setRelations((rs) => rs.map((r) => (r.id === relationId ? { ...r, pipelineStatus } : r)));
    // The column totals move with the card, so a header never disagrees with it.
    if (from) {
      setCounts((c) => ({ ...c, [from]: Math.max(0, (c[from] ?? 0) - 1), [pipelineStatus]: (c[pipelineStatus] ?? 0) + 1 }));
    }
    try {
      const res = await fetch(`/api/mentorship/${relationId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pipelineStatus, ...(opts?.reasonCode ? { reasonCode: opts.reasonCode, reasonNote: opts.reasonNote } : {}) }),
      });
      if (!res.ok) throw new Error('Failed');
      if (!opts?.silent && from) {
        toast(t.board.stageChanged, 'success', {
          label: t.board.undo,
          onClick: () => moveTo(relationId, from, { silent: true }),
        });
      }
    } catch {
      setRelations(prev);
      setCounts(prevCounts);
      toast(t.board.stageChangeFailed, 'error');
    }
  };

  // Gate for drag-and-drop and the per-card stage select: a move into a
  // negative/off-path stage collects a reason first (#810); everything else
  // goes straight to moveTo as before.
  const [pendingMove, setPendingMove] = useState<{ relationId: string; toStatus: string } | null>(null);
  const requestMove = (relationId: string, toStatus: string) => {
    if (stages.find((s) => s.key === toStatus)?.isOffPath) {
      setPendingMove({ relationId, toStatus });
    } else {
      moveTo(relationId, toStatus);
    }
  };

  // WCAG 4.1.3: the search box re-filters every column in place and moves no
  // focus, so the result count is a visual-only change. Announce it once the
  // typing settles (the hook debounces and de-duplicates).
  const q = search.trim().toLowerCase();
  // The server's total for the search, not the cards loaded.
  const matchCount = useMemo(() => (q ? Object.values(counts).reduce((a, b) => a + b, 0) : 0), [counts, q]);
  useFilterAnnouncement(
    q
      ? matchCount === 0
        ? t.a11y.noResultsShown
        : matchCount === 1
          ? t.a11y.resultsShownOne
          : t.a11y.resultsShown.replace('{count}', String(matchCount))
      : null
  );

  if (loading) return <div className="text-center py-12 text-gray-400" data-testid="page-loading">{t.common.loading}</div>;

  const now = Date.now();
  const itemsFor = (status: string) =>
    relations.filter(
      (r) => r.pipelineStatus === status &&
        (!q || r.mentee.fullName.toLowerCase().includes(q) || r.mentor.fullName.toLowerCase().includes(q))
    );

  // A column's true size (#1438) — after the search, which the server applies.
  const countFor = (status: string) => counts[status] ?? 0;
  const totalCount = Object.values(counts).reduce((a, b) => a + b, 0);

  // Every column as the WIP rule sees it — the server's count after the search
  // filter, so the chips and the header agree.
  const wipColumns: WipColumn[] = stages.map((s) => ({
    status: s.key,
    count: countFor(s.key),
    limit: resolvedWipLimit(s.key),
  }));
  // When every column breaches, the amber chips have stopped comparing
  // anything: they are replaced by one line that says the limit is wrong for
  // this programme and links to where it is changed (#1439).
  const wipSaturated = isWipSaturated(wipColumns);
  const wipLimitFor = (status: string) => (wipSaturated ? null : resolvedWipLimit(status));

  // Phone view opens on the first stage that has anyone in it (see the effect above).
  const activeStage = mobileStage || stages[0]?.key || '';

  const renderCard = (r: Relation) => {
    // Shared rule (src/lib/stageClock.ts, #1724). Terminal and off-path stages
    // never read as overdue — an accepted offer or a dropped candidate is not a
    // queue anybody is late on, which is what the candidate-detail chip has
    // always done and what this card used to miss.
    const overdue = isStageOverdue(
      { stageDeadline: r.stageDeadline, pipelineStatus: r.pipelineStatus, paused: r.stageClockPaused },
      stages,
      now
    );
    return (
      <div
        key={r.id}
        draggable
        onDragStart={(e) => e.dataTransfer.setData('relationId', r.id)}
        onClick={() => router.push(`/admin/candidates/${r.mentee.id}`)}
        data-testid="board-card"
        className="bg-white border border-gray-200 rounded-lg p-3 cursor-grab active:cursor-grabbing hover:border-blue-300 hover:shadow-sm transition"
      >
        <div className="flex items-start justify-between gap-2">
          {/* The name is a real link so the card is reachable (and openable) by keyboard. */}
          <Link
            href={`/admin/candidates/${r.mentee.id}`}
            onClick={(e) => e.stopPropagation()}
            className="text-sm font-medium text-gray-900 truncate hover:underline"
          >
            {r.mentee.fullName}
          </Link>
          {overdue && <OverdueBadge />}
        </div>
        {r.mentee.university && (
          <p className="text-xs text-gray-500 truncate mt-0.5">{r.mentee.university}</p>
        )}
        <div className="flex items-center gap-3 text-xs text-gray-400 mt-2">
          <span className="flex items-center gap-1 truncate">
            <User className="h-3 w-3 flex-shrink-0" />
            {/* stopPropagation lives in the card itself, so opening it does not
                also open the mentee behind the card's click-through. */}
            <PersonHoverCard personId={r.mentor.id} name={r.mentor.fullName} role="MENTOR" className="truncate" />
          </span>
          <span className="flex items-center gap-1 flex-shrink-0">
            <GraduationCap className="h-3 w-3" />
            {r._count.interactions}
          </span>
        </div>
        {r.nextActionAt && <div className="mt-1"><FollowUpChip at={r.nextActionAt} /></div>}
        <div className="mt-1 empty:hidden"><TrialEndChip pipelineStatus={r.pipelineStatus} trialEndsAt={r.trialEndsAt} /></div>
        {/* Keyboard/touch-accessible alternative to drag-and-drop. */}
        <CardStageSelect
          stages={stages}
          value={r.pipelineStatus}
          onChange={(next) => requestMove(r.id, next)}
        />
      </div>
    );
  };

  // "Show more" under a column whose cards are not all loaded (#1438).
  const renderLoadMore = (status: string, shown: number) =>
    // Hidden only while a typed search has not reached the server yet.
    (!q || q === serverSearch.toLowerCase()) && shown < countFor(status) ? (
      <button
        type="button"
        data-testid={`board-load-more-${status}`}
        disabled={loadingMore === status}
        onClick={() => loadMore(status)}
        className="mt-2 w-full rounded-lg border border-dashed border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-600 hover:border-blue-300 hover:text-blue-700 disabled:opacity-60"
      >
        {loadingMore === status ? t.common.loading : t.board.loadMore.replace('{shown}', String(shown)).replace('{total}', String(countFor(status)))}
      </button>
    ) : null;

  const renderColumn = (status: string) => {
    const items = itemsFor(status);
    return (
      <div
        key={status}
        // Keyed by stage so a test can name one column. Without it the only
        // handle is the header text, which also matches every card's "Move to
        // stage" <option> and trips strict mode (#828).
        data-testid={`board-column-${status}`}
        // The drop target is highlighted with bg-blue-50, which forced-colors
        // discards; this attribute lets globals.css outline it instead (#2045).
        data-drop-active={dragOver === status ? 'true' : undefined}
        onDragOver={(e) => { e.preventDefault(); setDragOver(status); }}
        onDragLeave={() => setDragOver((s) => (s === status ? null : s))}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(null);
          const id = e.dataTransfer.getData('relationId');
          if (id) requestMove(id, status);
        }}
        className={`flex-shrink-0 w-64 rounded-xl border p-3 transition-colors ${
          dragOver === status ? 'border-blue-400 bg-blue-50' : 'border-gray-200 bg-gray-50'
        }`}
      >
        <BoardColumnHeader status={status} label={label(status)} count={countFor(status)} limit={wipLimitFor(status)} />

        <div className="space-y-2 min-h-[40px]">
          {items.map(renderCard)}
        </div>
        {renderLoadMore(status, items.length)}
      </div>
    );
  };

  return (
    <div>
      <div className="mb-6">
        <h1 className="flex items-center gap-2 text-2xl font-bold text-gray-900 dark:text-gray-100">
          {t.nav.board}
          <HelpTip helpKey="board" />
        </h1>
        <p className="text-gray-500 mt-1">{t.adminBoard.subtitle}</p>
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <input
          type="search"
          data-testid="board-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t.adminBoard.searchPlaceholder}
          className="flex-1 min-w-[180px] max-w-sm rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400"
        />
        <label className="flex items-center gap-2 text-sm text-gray-600">
          <input type="checkbox" checked={hideEmpty} onChange={(e) => setHideEmpty(e.target.checked)} />
          {t.adminBoard.hideEmpty}
        </label>
      </div>
      <div className="mb-4">
        <SavedViews
          storageKey="board-views"
          surface="board"
          current={{ search, hideEmpty: hideEmpty ? 'true' : 'false' }}
          onApply={(f) => {
            setSearch(f.search || '');
            setHideEmpty(f.hideEmpty === 'true');
          }}
        />
      </div>

      {totalCount === 0 && !serverSearch ? (
        /* Day one for a whole tenant: no mentorships at all, so no board. The
           step that fills it is inviting people, which is an admin route. */
        <Card>
          <EmptyState
            testId="admin-board"
            icon={LayoutGrid}
            role="ADMIN"
            title={t.emptyStates.board.title}
            byRole={{
              ADMIN: {
                body: t.emptyStates.board.adminBody,
                action: { label: t.emptyStates.board.adminCta, href: '/admin/invite' },
              },
            }}
          />
        </Card>
      ) : narrow ? (
        /* Phone: one stage at a time as a list — 13 columns don't fit at 390px.
           Search above still applies, so the list is search ∩ stage. */
        <div data-testid="board-mobile">
          <BoardStageFilter
            stages={stages}
            countFor={countFor}
            value={activeStage}
            onChange={setMobileStage}
          />
          <div className="space-y-2">
            {itemsFor(activeStage).map(renderCard)}
            {renderLoadMore(activeStage, itemsFor(activeStage).length)}
            {itemsFor(activeStage).length === 0 && (
              <EmptyState
                testId="admin-board-stage"
                size="sm"
                icon={LayoutGrid}
                title={t.emptyStates.boardStage.title}
                body={t.emptyStates.boardStage.body}
              />
            )}
          </div>
        </div>
      ) : (
      <div data-testid="board-columns" className="space-y-5">
        {wipSaturated && (
          <div
            data-testid="board-wip-saturated"
            className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
          >
            {t.adminBoard.wipSaturated}{' '}
            <Link href="/admin/settings" className="underline font-medium">
              {t.adminBoard.wipSaturatedAction}
            </Link>
          </div>
        )}
        <BoardPhaseGroups
          groups={groups}
          countFor={countFor}
          hideEmpty={hideEmpty}
          renderColumns={(statuses) => statuses.map(renderColumn)}
        />
      </div>
      )}

      <DropoffReasonDialog
        open={!!pendingMove}
        stageLabel={pendingMove ? label(pendingMove.toStatus) : ''}
        onConfirm={(reasonCode, reasonNote) => {
          if (pendingMove) moveTo(pendingMove.relationId, pendingMove.toStatus, { reasonCode, reasonNote });
          setPendingMove(null);
        }}
        onCancel={() => setPendingMove(null)}
      />
    </div>
  );
}
