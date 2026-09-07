'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { GraduationCap, LayoutGrid, Search } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { useResolvedStages, useStageLabel } from '@/lib/pipelineStagesClient';
import { useT } from '@/i18n/client';
import { useToast } from '@/components/ui/Toast';
import { useIsNarrow } from '@/hooks/useIsNarrow';
import { BoardStageFilter } from '@/components/board/BoardStageFilter';
import { CardStageSelect } from '@/components/board/CardStageSelect';
import { HorizontalScrollArea } from '@/components/board/HorizontalScrollArea';
import { DropoffReasonDialog } from '@/components/DropoffReasonDialog';
import { StageClockChip } from '@/components/StageClockChip';
import { useFilterAnnouncement } from '@/hooks/useFilterAnnouncement';
import { foldSearchText, matchesMenteeQuery } from '@/lib/menteeFilter';

interface Mentee {
  id: string;
  fullName: string;
  email?: string;
  university?: string;
}

interface Relation {
  id: string;
  status?: string;
  pipelineStatus: string;
  // The stage clock (#1724), both served by GET /api/mentorship inside the
  // caller's existing scope. `stageDeadline` is the org's per-stage SLA once
  // one is configured (lib/stageSla.ts); `daysInStage` is the shared
  // days-in-stage number the aging report and the analytics export also use.
  stageDeadline?: string | null;
  daysInStage?: number | null;
  // The mentee is in the re-engagement pool (#834): an agreed "we'll write in
  // September", so the clock shows but never turns red.
  stageClockPaused?: boolean;
  mentee: Mentee;
  _count: { interactions: number };
}

export default function MentorBoardPage() {
  const t = useT();
  const label = useStageLabel();
  const stages = useResolvedStages();
  const router = useRouter();
  const toast = useToast();
  const narrow = useIsNarrow();
  const [relations, setRelations] = useState<Relation[]>([]);
  // moveTo is also called much later from a toast's "Undo", where the closed-over
  // `relations` would be stale — read the live list through a ref instead.
  const relationsRef = useRef<Relation[]>([]);
  const [loading, setLoading] = useState(true);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [mobileStage, setMobileStage] = useState('');
  // Client-side by design: this page fetches the mentor's whole relation list
  // (GET /api/mentorship pages only for callers that pass `page`), so the box
  // searches every mentee, not a visible page. The matching rule is shared with
  // /mentor/mentees — see src/lib/menteeFilter.ts.
  const [search, setSearch] = useState('');

  const fetchRelations = useCallback(async () => {
    const res = await fetch('/api/mentorship');
    const data = await res.json();
    setRelations(data.relations ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    relationsRef.current = relations;
  }, [relations]);

  useEffect(() => {
    fetchRelations();
  }, [fetchRelations]);

  // Pin the phone filter to a real stage once data is in: deriving it on every
  // render made the view follow a card to its new stage, so you never saw it
  // leave the stage you were looking at.
  useEffect(() => {
    if (mobileStage || loading || stages.length === 0) return;
    const firstWithItems = stages.find((s) => relations.some((r) => r.pipelineStatus === s.key));
    setMobileStage(firstWithItems?.key ?? stages[0].key);
  }, [mobileStage, loading, stages, relations]);

  // `silent` suppresses the undo offer, so undoing a move can't offer to undo itself.
  // reasonCode/reasonNote (#810): required server-side when pipelineStatus is a
  // negative/off-path stage — requestMove() below gates that before calling here.
  // Undo intentionally does NOT collect a reason even when it lands back on a
  // negative stage; the server still enforces the rule, so a reason-less undo
  // into a negative stage fails safely (reverted + error toast) rather than
  // silently bypassing validation.
  const moveTo = async (relationId: string, pipelineStatus: string, opts?: { silent?: boolean; reasonCode?: string; reasonNote?: string }) => {
    const prev = relationsRef.current;
    const from = prev.find((r) => r.id === relationId)?.pipelineStatus;
    if (from === pipelineStatus) return;
    // optimistic update
    setRelations((rs) => rs.map((r) => (r.id === relationId ? { ...r, pipelineStatus } : r)));
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
      setRelations(prev); // revert on failure
      toast(t.board.stageChangeFailed, 'error');
    }
  };

  // Gate for drag-and-drop and the per-card stage select: a move into a
  // negative/off-path stage collects a reason first (#810).
  const [pendingMove, setPendingMove] = useState<{ relationId: string; toStatus: string } | null>(null);
  const requestMove = (relationId: string, toStatus: string) => {
    if (stages.find((s) => s.key === toStatus)?.isOffPath) {
      setPendingMove({ relationId, toStatus });
    } else {
      moveTo(relationId, toStatus);
    }
  };

  // WCAG 4.1.3, same as the admin board: the box re-filters every column in
  // place and moves no focus, so the outcome is announced once typing settles.
  const q = foldSearchText(search);
  const matchCount = useMemo(
    () => (q ? relations.filter((r) => matchesMenteeQuery(r, q)).length : 0),
    [relations, q],
  );
  useFilterAnnouncement(
    q
      ? matchCount === 0
        ? t.a11y.noResultsShown
        : matchCount === 1
          ? t.a11y.resultsShownOne
          : t.a11y.resultsShown.replace('{count}', String(matchCount))
      : null,
  );

  if (loading) return <div className="text-center py-12 text-gray-400">{t.common.loading}</div>;

  // Search ∩ stage. Every column header count is derived from this, so the
  // numbers describe what is actually on screen rather than the unfiltered set.
  const itemsFor = (status: string) =>
    relations.filter((r) => r.pipelineStatus === status && matchesMenteeQuery(r, q));

  const renderCard = (r: Relation) => (
    <div
      key={r.id}
      draggable
      onDragStart={(e) => e.dataTransfer.setData('relationId', r.id)}
      onClick={() => router.push(`/mentor/mentees/${r.id}`)}
      data-testid="board-card"
      className="bg-white border border-gray-200 rounded-lg p-3 cursor-grab active:cursor-grabbing hover:border-blue-300 hover:shadow-sm transition"
    >
      <div className="flex items-start justify-between gap-2">
        {/* The name is a real link so the card is reachable (and openable) by keyboard. */}
        <Link
          href={`/mentor/mentees/${r.id}`}
          onClick={(e) => e.stopPropagation()}
          className="block min-w-0 text-sm font-medium text-gray-900 truncate hover:underline"
        >
          {r.mentee.fullName}
        </Link>
        <StageClockChip
          testId={`stage-clock-${r.id}`}
          daysInStage={r.daysInStage}
          stageDeadline={r.stageDeadline}
          pipelineStatus={r.pipelineStatus}
          relationStatus={r.status}
          paused={r.stageClockPaused}
        />
      </div>
      {r.mentee.university && (
        <p className="text-xs text-gray-500 truncate mt-0.5">{r.mentee.university}</p>
      )}
      <div className="flex items-center gap-1 text-xs text-gray-400 mt-2">
        <GraduationCap className="h-3 w-3" />
        {r._count.interactions} {t.mentor.interactions}
      </div>
      <CardStageSelect
        stages={stages}
        value={r.pipelineStatus}
        onChange={(next) => requestMove(r.id, next)}
      />
    </div>
  );

  // Phone: one stage at a time as a list (13 columns don't fit at 390px).
  const activeStage = mobileStage || stages[0]?.key || '';

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.nav.board}</h1>
        <p className="text-gray-500 mt-1">
          {t.mentor.boardSubtitle}
        </p>
      </div>

      {relations.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <div className="relative w-full sm:w-80">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <input
              type="search"
              data-testid="mentor-board-search"
              aria-label={t.mentor.menteeBoardSearchPlaceholder}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t.mentor.menteeBoardSearchPlaceholder}
              className="min-h-11 w-full rounded-lg border border-gray-300 pl-9 pr-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400"
            />
          </div>
          {q && matchCount === 0 && (
            <span className="text-sm text-gray-500 dark:text-gray-400" data-testid="mentor-board-no-match">
              {t.mentor.noMatchingMentees}
            </span>
          )}
        </div>
      )}

      {relations.length === 0 ? (
        /* Day one for a mentor: no assignment yet, so no board. Deliberately no
           button — assigning a mentorship is an admin action. */
        <Card>
          <EmptyState
            testId="mentor-board"
            icon={LayoutGrid}
            role="MENTOR"
            title={t.emptyStates.board.title}
            byRole={{ MENTOR: { body: t.emptyStates.board.mentorBody } }}
          />
        </Card>
      ) : narrow ? (
        <div data-testid="board-mobile">
          <BoardStageFilter
            stages={stages}
            countFor={(s) => itemsFor(s).length}
            value={activeStage}
            onChange={setMobileStage}
          />
          <div className="space-y-2">
            {itemsFor(activeStage).map(renderCard)}
            {itemsFor(activeStage).length === 0 && (
              <EmptyState
                testId="mentor-board-stage"
                size="sm"
                icon={LayoutGrid}
                title={t.emptyStates.boardStage.title}
                body={t.emptyStates.boardStage.body}
              />
            )}
          </div>
        </div>
      ) : (
        <HorizontalScrollArea testId="board-columns" label={t.a11y.scrollableColumns} className="flex gap-4 pb-4">
          {stages.map((s) => {
            const status = s.key;
            const items = itemsFor(status);
            return (
              <div
                key={status}
                data-testid={`board-column-${status}`}
                // See the admin board: forced-colors drops the bg-blue-50 drop
                // target highlight, so mark the state for globals.css (#2045).
                data-drop-active={dragOver === status ? 'true' : undefined}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(status);
                }}
                onDragLeave={() => setDragOver((prev) => (prev === status ? null : prev))}
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
                <div className="flex items-center justify-between mb-3 px-1">
                  <span className="text-xs font-semibold text-gray-700">{label(status)}</span>
                  {/* Derived from the same filtered `items` the column renders,
                      so the badge never claims rows the search has hidden. */}
                  <span
                    data-testid={`board-column-count-${status}`}
                    className="text-xs text-gray-400 bg-white border border-gray-200 rounded-full px-2 py-0.5"
                  >
                    {items.length}
                  </span>
                </div>

                <div className="space-y-2 min-h-[40px]">
                  {items.map(renderCard)}
                </div>
              </div>
            );
          })}
        </HorizontalScrollArea>
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
