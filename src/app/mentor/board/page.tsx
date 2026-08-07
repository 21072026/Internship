'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { GraduationCap } from 'lucide-react';
import { useResolvedStages, useStageLabel } from '@/lib/pipelineStagesClient';
import { useT } from '@/i18n/client';
import { useToast } from '@/components/ui/Toast';
import { useIsNarrow } from '@/hooks/useIsNarrow';
import { BoardStageFilter } from '@/components/board/BoardStageFilter';
import { CardStageSelect } from '@/components/board/CardStageSelect';
import { DropoffReasonDialog } from '@/components/DropoffReasonDialog';

interface Mentee {
  id: string;
  fullName: string;
  university?: string;
}

interface Relation {
  id: string;
  pipelineStatus: string;
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

  if (loading) return <div className="text-center py-12 text-gray-400">{t.common.loading}</div>;

  const itemsFor = (status: string) => relations.filter((r) => r.pipelineStatus === status);

  const renderCard = (r: Relation) => (
    <div
      key={r.id}
      draggable
      onDragStart={(e) => e.dataTransfer.setData('relationId', r.id)}
      onClick={() => router.push(`/mentor/mentees/${r.id}`)}
      data-testid="board-card"
      className="bg-white border border-gray-200 rounded-lg p-3 cursor-grab active:cursor-grabbing hover:border-blue-300 hover:shadow-sm transition"
    >
      {/* The name is a real link so the card is reachable (and openable) by keyboard. */}
      <Link
        href={`/mentor/mentees/${r.id}`}
        onClick={(e) => e.stopPropagation()}
        className="block text-sm font-medium text-gray-900 truncate hover:underline"
      >
        {r.mentee.fullName}
      </Link>
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

      {narrow ? (
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
        <div data-testid="board-columns" className="flex gap-4 overflow-x-auto pb-4">
          {stages.map((s) => {
            const status = s.key;
            const items = itemsFor(status);
            return (
              <div
                key={status}
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
                  <span className="text-xs text-gray-400 bg-white border border-gray-200 rounded-full px-2 py-0.5">
                    {items.length}
                  </span>
                </div>

                <div className="space-y-2 min-h-[40px]">
                  {items.map(renderCard)}
                </div>
              </div>
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
