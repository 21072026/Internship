'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { GraduationCap, User, ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react';
import { PIPELINE_STATUSES, PIPELINE_GROUPS, pipelineLabel, type PipelineGroupKey } from '@/lib/pipeline';
import { useT, useLocale } from '@/i18n/client';

interface Relation {
  id: string;
  pipelineStatus: string;
  stageDeadline?: string | null;
  mentee: { id: string; fullName: string; university?: string };
  mentor: { fullName: string };
  _count: { interactions: number };
}

// Soft work-in-progress limit: a column holding more than this many candidates
// gets an amber count so bottlenecks stand out. Advisory only — never blocks.
const WIP_LIMIT = 8;

// Admin kanban across ALL mentorship relations (every mentor's mentees).
// Stages are grouped into three collapsible phases so 13 columns don't sprawl.
export default function AdminBoardPage() {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const [relations, setRelations] = useState<Relation[]>([]);
  const [loading, setLoading] = useState(true);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [hideEmpty, setHideEmpty] = useState(false);
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

  const q = search.trim().toLowerCase();
  const now = Date.now();
  const itemsFor = (status: string) =>
    relations.filter(
      (r) => r.pipelineStatus === status &&
        (!q || r.mentee.fullName.toLowerCase().includes(q) || r.mentor.fullName.toLowerCase().includes(q))
    );

  const toggleGroup = (key: PipelineGroupKey) =>
    setCollapsed((c) => ({ ...c, [key]: !c[key] }));

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
          if (id) moveTo(id, status);
        }}
        className={`flex-shrink-0 w-64 rounded-xl border p-3 transition-colors ${
          dragOver === status ? 'border-blue-400 bg-blue-50' : 'border-gray-200 bg-gray-50'
        }`}
      >
        <div className="flex items-center justify-between mb-3 px-1">
          <span className="text-xs font-semibold text-gray-700">{pipelineLabel(status, locale)}</span>
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
          {items.map((r) => {
            const overdue = !!r.stageDeadline && new Date(r.stageDeadline).getTime() < now;
            return (
              <div
                key={r.id}
                draggable
                onDragStart={(e) => e.dataTransfer.setData('relationId', r.id)}
                onClick={() => router.push(`/admin/candidates/${r.mentee.id}`)}
                className="bg-white border border-gray-200 rounded-lg p-3 cursor-grab active:cursor-grabbing hover:border-blue-300 hover:shadow-sm transition"
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-medium text-gray-900 truncate">{r.mentee.fullName}</p>
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
                    {r.mentor.fullName}
                  </span>
                  <span className="flex items-center gap-1 flex-shrink-0">
                    <GraduationCap className="h-3 w-3" />
                    {r._count.interactions}
                  </span>
                </div>
                {/* Keyboard/touch-accessible alternative to drag-and-drop. */}
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
            );
          })}
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

      <div className="space-y-5">
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
                <div className="flex gap-4 overflow-x-auto px-3 pb-4">
                  {statuses.map(renderColumn)}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
