'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { GraduationCap, User, ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react';
import { PIPELINE_GROUPS, type PipelineGroupKey } from '@/lib/pipeline';
import { useResolvedStages, useStageLabel } from '@/lib/pipelineStagesClient';
import { useT } from '@/i18n/client';
import { useToast } from '@/components/ui/Toast';
import { useIsNarrow } from '@/hooks/useIsNarrow';
import { BoardStageFilter } from '@/components/board/BoardStageFilter';
import { CardStageSelect } from '@/components/board/CardStageSelect';
import { HorizontalScrollArea } from '@/components/board/HorizontalScrollArea';
import { DropoffReasonDialog } from '@/components/DropoffReasonDialog';
import { PersonHoverCard } from '@/components/PersonHoverCard';

interface Relation {
  id: string;
  pipelineStatus: string;
  stageDeadline?: string | null;
  mentee: { id: string; fullName: string; university?: string };
  mentor: { id: string; fullName: string };
  _count: { interactions: number };
}

// Soft work-in-progress limit: a column holding more than this many candidates
// gets an amber count so bottlenecks stand out. Advisory only — never blocks.
const WIP_LIMIT = 8;

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
  // moveTo is also called much later from a toast's "Undo", where the closed-over
  // `relations` would be stale — read the live list through a ref instead.
  const relationsRef = useRef<Relation[]>([]);
  const [loading, setLoading] = useState(true);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [hideEmpty, setHideEmpty] = useState(false);
  const [mobileStage, setMobileStage] = useState('');
  const [collapsed, setCollapsed] = useState<Record<PipelineGroupKey, boolean>>({
    pre: false,
    internship: false,
    result: false,
  });

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

  if (loading) return <div className="text-center py-12 text-gray-400">{t.common.loading}</div>;

  const q = search.trim().toLowerCase();
  const now = Date.now();
  const itemsFor = (status: string) =>
    relations.filter(
      (r) => r.pipelineStatus === status &&
        (!q || r.mentee.fullName.toLowerCase().includes(q) || r.mentor.fullName.toLowerCase().includes(q))
    );

  const toggleGroup = (key: PipelineGroupKey) =>
    setCollapsed((c) => ({ ...c, [key]: !c[key] }));

  // Phone view opens on the first stage that has anyone in it (see the effect above).
  const activeStage = mobileStage || stages[0]?.key || '';

  const renderCard = (r: Relation) => {
    const overdue = !!r.stageDeadline && new Date(r.stageDeadline).getTime() < now;
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
    const overLimit = items.length > WIP_LIMIT;
    return (
      <div
        key={status}
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
          <span className="text-xs font-semibold text-gray-700">{label(status)}</span>
          <span
            title={overLimit ? t.adminBoard.wipWarning : undefined}
            className={`text-xs rounded-full px-2 py-0.5 border ${
              overLimit
                ? 'text-amber-700 bg-amber-50 border-amber-300 font-semibold'
                : 'text-gray-400 bg-white border-gray-200'
            }`}
          >
            {items.length}{overLimit ? ` / ${WIP_LIMIT}` : ''}
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

      {narrow ? (
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
              <p className="text-center py-8 text-sm text-gray-400">{t.board.emptyStage}</p>
            )}
          </div>
        </div>
      ) : (
      <div data-testid="board-columns" className="space-y-5">
        {PIPELINE_GROUPS.map((group) => {
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
                <span className="text-xs text-gray-400 bg-gray-100 rounded-full px-2 py-0.5">{groupTotal}</span>
              </button>
              {!isCollapsed && (
                <HorizontalScrollArea testId={`board-scroll-${group.key}`} className="flex gap-4 px-3 pb-4">
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
