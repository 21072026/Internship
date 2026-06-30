'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { GraduationCap, User } from 'lucide-react';
import { PIPELINE_STATUSES, pipelineLabel } from '@/lib/pipeline';
import { useT, useLocale } from '@/i18n/client';

interface Relation {
  id: string;
  pipelineStatus: string;
  mentee: { id: string; fullName: string; university?: string };
  mentor: { fullName: string };
  _count: { interactions: number };
}

// Admin kanban across ALL mentorship relations (every mentor's mentees).
// Reuses the mentor-board mechanics: drag a card to change its pipeline stage.
export default function AdminBoardPage() {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const [relations, setRelations] = useState<Relation[]>([]);
  const [loading, setLoading] = useState(true);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [hideEmpty, setHideEmpty] = useState(false);

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
    setRelations((rs) => rs.map((r) => (r.id === relationId ? { ...r, pipelineStatus } : r)));
    try {
      const res = await fetch(`/api/mentorship/${relationId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pipelineStatus }),
      });
      if (!res.ok) throw new Error('Failed');
    } catch {
      setRelations(prev);
    }
  };

  if (loading) return <div className="text-center py-12 text-gray-400">{t.common.loading}</div>;

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">{t.nav.board}</h1>
        <p className="text-gray-500 mt-1">{t.adminBoard.subtitle}</p>
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <input
          type="search"
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

      <div className="flex gap-4 overflow-x-auto pb-4">
        {PIPELINE_STATUSES.map((status) => {
          const q = search.trim().toLowerCase();
          const items = relations.filter(
            (r) => r.pipelineStatus === status &&
              (!q || r.mentee.fullName.toLowerCase().includes(q) || r.mentor.fullName.toLowerCase().includes(q))
          );
          if (hideEmpty && items.length === 0) return null;
          return (
            <div
              key={status}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(status);
              }}
              onDragLeave={() => setDragOver((s) => (s === status ? null : s))}
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
                <span className="text-xs font-semibold text-gray-700">{pipelineLabel(status, locale)}</span>
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
                    onClick={() => router.push(`/admin/candidates/${r.mentee.id}`)}
                    className="bg-white border border-gray-200 rounded-lg p-3 cursor-grab active:cursor-grabbing hover:border-blue-300 hover:shadow-sm transition"
                  >
                    <p className="text-sm font-medium text-gray-900 truncate">{r.mentee.fullName}</p>
                    {r.mentee.university && (
                      <p className="text-xs text-gray-500 truncate mt-0.5">{r.mentee.university}</p>
                    )}
                    <div className="flex items-center gap-3 text-xs text-gray-400 mt-2">
                      <span className="flex items-center gap-1 truncate">
                        <User className="h-3 w-3 flex-shrink-0" />
                        {r.mentor.fullName}
                      </span>
                      <span className="flex items-center gap-1 flex-shrink-0">
                        <GraduationCap className="h-3 w-3" />
                        {r._count.interactions}
                      </span>
                    </div>
                    {/* Keyboard-accessible alternative to drag-and-drop. */}
                    <select
                      aria-label={t.adminBoard.moveTo}
                      value={status}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => { e.stopPropagation(); moveTo(r.id, e.target.value); }}
                      className="mt-2 w-full rounded border border-gray-200 px-1.5 py-1 text-xs text-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-100"
                    >
                      {PIPELINE_STATUSES.map((sv) => (
                        <option key={sv} value={sv}>{pipelineLabel(sv, locale)}</option>
                      ))}
                    </select>
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
