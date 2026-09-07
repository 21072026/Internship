'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { GraduationCap, User, ChevronDown, ChevronRight, AlertTriangle, LayoutGrid } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { groupResolvedStages, type PipelineGroupKey } from '@/lib/pipeline';
import { useResolvedStages, useStageLabel } from '@/lib/pipelineStagesClient';
import { useT } from '@/i18n/client';
import { useToast } from '@/components/ui/Toast';
import { useIsNarrow } from '@/hooks/useIsNarrow';
import { useFilterAnnouncement } from '@/hooks/useFilterAnnouncement';
import { BoardStageFilter } from '@/components/board/BoardStageFilter';
import { CardStageSelect } from '@/components/board/CardStageSelect';
import { HorizontalScrollArea } from '@/components/board/HorizontalScrollArea';
import { DropoffReasonDialog } from '@/components/DropoffReasonDialog';
import { PersonHoverCard } from '@/components/PersonHoverCard';
import { isStageOverdue } from '@/lib/stageClock';
import {
  DEFAULT_BOARD_WIP_LIMIT,
  isOverWipLimit,
  isWipSaturated,
  resolveWipLimit,
  type WipColumn,
} from '@/lib/boardWip';

interface Relation {
  id: string;
  pipelineStatus: string;
  stageDeadline?: string | null;
  // Served by GET /api/mentorship since #1724: the mentee sits in the
  // re-engagement pool, so this card can never read as a breach — the same
  // exclusion the admin aging report applies to its own overdue list.
  stageClockPaused?: boolean;
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
  // Both come from the one endpoint that already answers "what applies to this
  // stage"; the rule that combines them lives in src/lib/boardWip.ts.
  const [wipDefault, setWipDefault] = useState<number | null>(DEFAULT_BOARD_WIP_LIMIT);
  const [wipPerStage, setWipPerStage] = useState<Record<string, number | null>>({});
  // moveTo is also called much later from a toast's "Undo", where the closed-over
  // `relations` would be stale — read the live list through a ref instead.
  const relationsRef = useRef<Relation[]>([]);
  const [loading, setLoading] = useState(true);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [hideEmpty, setHideEmpty] = useState(false);
  const [mobileStage, setMobileStage] = useState('');
  // Keyed by group, but by a plain string: a tenant with custom stages gets a
  // "custom" group that isn't one of the three built-ins, and an unvisited key
  // reads as undefined → expanded, which is the wanted default anyway.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  // The groups the VIEWER actually has (#828) — built from the resolved stages,
  // so a customized pipeline is not silently dropped on the desktop board.
  const groups = useMemo(() => groupResolvedStages(stages), [stages]);

  const fetchRelations = useCallback(async () => {
    const res = await fetch('/api/mentorship');
    const data = await res.json();
    setRelations(data.relations ?? []);
    setLoading(false);
  }, []);

  // Advisory decoration on top of the board: a failed request leaves the
  // resolved default in place rather than blanking the board or retrying.
  const fetchWipLimits = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/stage-sla');
      if (!res.ok) return;
      const data = await res.json();
      setWipDefault(data.defaultWipLimit ?? null);
      setWipPerStage(
        Object.fromEntries(
          ((data.stages ?? []) as { key: string; wipLimit: number | null }[]).map((s) => [s.key, s.wipLimit ?? null])
        )
      );
    } catch {
      /* keep the default */
    }
  }, []);

  useEffect(() => {
    fetchWipLimits();
  }, [fetchWipLimits]);

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
      setRelations(prev);
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
  const matchCount = useMemo(
    () =>
      q
        ? relations.filter(
            (r) => r.mentee.fullName.toLowerCase().includes(q) || r.mentor.fullName.toLowerCase().includes(q)
          ).length
        : 0,
    [relations, q]
  );
  useFilterAnnouncement(
    q
      ? matchCount === 0
        ? t.a11y.noResultsShown
        : matchCount === 1
          ? t.a11y.resultsShownOne
          : t.a11y.resultsShown.replace('{count}', String(matchCount))
      : null
  );

  if (loading) return <div className="text-center py-12 text-gray-400">{t.common.loading}</div>;

  const now = Date.now();
  const itemsFor = (status: string) =>
    relations.filter(
      (r) => r.pipelineStatus === status &&
        (!q || r.mentee.fullName.toLowerCase().includes(q) || r.mentor.fullName.toLowerCase().includes(q))
    );

  // Every column as the WIP rule sees it — counted AFTER the search filter, so
  // the chips and this agree about what is on screen.
  const wipColumns: WipColumn[] = stages.map((s) => ({
    status: s.key,
    count: itemsFor(s.key).length,
    limit: resolveWipLimit(s.key, wipDefault, wipPerStage),
  }));
  // When every column breaches, the amber chips have stopped comparing
  // anything: they are replaced by one line that says the limit is wrong for
  // this programme and links to where it is changed (#1439).
  const wipSaturated = isWipSaturated(wipColumns);
  const wipLimitFor = (status: string) =>
    wipSaturated ? null : resolveWipLimit(status, wipDefault, wipPerStage);

  const toggleGroup = (key: PipelineGroupKey) =>
    setCollapsed((c) => ({ ...c, [key]: !c[key] }));

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
          {overdue && (
            <span className="flex-shrink-0 flex items-center gap-1 text-[10px] font-medium text-red-600 bg-red-50 border border-red-200 rounded-full px-1.5 py-0.5">
              <AlertTriangle className="h-3 w-3" />
              {t.adminBoard.overdue}
            </span>
          )}
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
        {/* Keyboard/touch-accessible alternative to drag-and-drop. */}
        <CardStageSelect
          stages={stages}
          value={r.pipelineStatus}
          onChange={(next) => requestMove(r.id, next)}
        />
      </div>
    );
  };

  const renderColumn = (status: string) => {
    const items = itemsFor(status);
    const limit = wipLimitFor(status);
    const overLimit = isOverWipLimit({ status, count: items.length, limit });
    // Says WHICH limit was passed, rather than "over the recommended limit" —
    // with the number configurable per stage, a warning that does not name it
    // cannot be acted on.
    const wipWarning = overLimit
      ? t.adminBoard.wipWarning.replace('{count}', String(items.length)).replace('{limit}', String(limit))
      : undefined;
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
        <div className="flex items-center justify-between mb-3 px-1">
          <span data-testid={`board-column-title-${status}`} className="text-xs font-semibold text-gray-700">{label(status)}</span>
          <span
            /* Named so a test can read one column's count and its warning
               without matching on the label text (#1346). */
            data-testid={`board-column-count-${status}`}
            title={wipWarning}
            className={`text-xs rounded-full px-2 py-0.5 border ${
              overLimit
                ? 'text-amber-700 bg-amber-50 border-amber-300 font-semibold'
                : 'text-gray-400 bg-white border-gray-200'
            }`}
          >
            {items.length}{overLimit ? ` / ${limit}` : ''}
            {/* A `title` on a plain span reaches a mouse and nothing else. */}
            {wipWarning && <span className="sr-only">{wipWarning}</span>}
          </span>
        </div>

        <div className="space-y-2 min-h-[40px]">
          {items.map(renderCard)}
        </div>
      </div>
    );
  };

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.nav.board}</h1>
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

      {relations.length === 0 ? (
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
            countFor={(s) => itemsFor(s).length}
            value={activeStage}
            onChange={setMobileStage}
          />
          <div className="space-y-2">
            {itemsFor(activeStage).map(renderCard)}
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
        {groups.map((group) => {
          const statuses = hideEmpty
            ? group.statuses.filter((s) => itemsFor(s).length > 0)
            : group.statuses;
          const groupTotal = group.statuses.reduce((n, s) => n + itemsFor(s).length, 0);
          if (hideEmpty && groupTotal === 0) return null;
          const isCollapsed = collapsed[group.key];
          return (
            <section key={group.key} className="rounded-xl border border-gray-100 bg-white/40">
              <button
                type="button"
                onClick={() => toggleGroup(group.key)}
                aria-expanded={!isCollapsed}
                className="w-full flex items-center gap-2 px-3 py-2 text-left"
              >
                {isCollapsed ? <ChevronRight className="h-4 w-4 text-gray-400" /> : <ChevronDown className="h-4 w-4 text-gray-400" />}
                <span className="text-sm font-semibold text-gray-800">
                  {(t.adminBoard.groups as Record<string, string>)[group.key]}
                </span>
                {/* gray-700, not the muted token: this chip carries its own
                    gray-100 background, and even the raised gray-500 only makes
                    4.4:1 on it (4.1:1 on the dark remap) — #2131. */}
                <span className="text-xs text-gray-700 bg-gray-100 rounded-full px-2 py-0.5">{groupTotal}</span>
              </button>
              {!isCollapsed && (
                <HorizontalScrollArea
                  testId={`board-scroll-${group.key}`}
                  label={t.a11y.scrollableColumns}
                  className="flex gap-4 px-3 pb-4"
                >
                  {statuses.map(renderColumn)}
                </HorizontalScrollArea>
              )}
            </section>
          );
        })}
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
