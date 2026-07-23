'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { GraduationCap } from 'lucide-react';
import { useResolvedStages, useStageLabel } from '@/lib/pipelineStagesClient';
import { useT } from '@/i18n/client';

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
  const [relations, setRelations] = useState<Relation[]>([]);
  const [loading, setLoading] = useState(true);
  const [dragOver, setDragOver] = useState<string | null>(null);

  const fetchRelations = useCallback(async () => {
    const res = await fetch('/api/mentorship');
    const data = await res.json();
    setRelations(data.relations ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchRelations();
  }, [fetchRelations]);

  const moveTo = async (relationId: string, pipelineStatus: string) => {
    const prev = relations;
    // optimistic update
    setRelations((rs) => rs.map((r) => (r.id === relationId ? { ...r, pipelineStatus } : r)));
    try {
      const res = await fetch(`/api/mentorship/${relationId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pipelineStatus }),
      });
      if (!res.ok) throw new Error('Failed');
    } catch {
      setRelations(prev); // revert on failure
    }
  };

  if (loading) return <div className="text-center py-12 text-gray-400">{t.common.loading}</div>;

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.nav.board}</h1>
        <p className="text-gray-500 mt-1">
          {t.mentor.boardSubtitle}
        </p>
      </div>

      <div className="flex gap-4 overflow-x-auto pb-4">
        {stages.map((s) => {
          const status = s.key;
          const items = relations.filter((r) => r.pipelineStatus === status);
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
                if (id) moveTo(id, status);
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
                {items.map((r) => (
                  <div
                    key={r.id}
                    draggable
                    onDragStart={(e) => e.dataTransfer.setData('relationId', r.id)}
                    onClick={() => router.push(`/mentor/mentees/${r.id}`)}
                    className="bg-white border border-gray-200 rounded-lg p-3 cursor-grab active:cursor-grabbing hover:border-blue-300 hover:shadow-sm transition"
                  >
                    <p className="text-sm font-medium text-gray-900 truncate">{r.mentee.fullName}</p>
                    {r.mentee.university && (
                      <p className="text-xs text-gray-500 truncate mt-0.5">{r.mentee.university}</p>
                    )}
                    <div className="flex items-center gap-1 text-xs text-gray-400 mt-2">
                      <GraduationCap className="h-3 w-3" />
                      {r._count.interactions} {t.mentor.interactions}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
