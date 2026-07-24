'use client';

import { useCallback, useEffect, useState } from 'react';
import { Archive, Check, Circle, Pencil, Trash2 } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { useT, useLocale } from '@/i18n/client';
import { formatDate } from '@/lib/relativeTime';

interface Goal {
  id: string;
  title: string;
  description: string | null;
  status: 'OPEN' | 'DONE';
  dueDate: string | null;
  createdAt: string;
  createdByRole: string | null;
}

// Goal setting + tracking for a mentorship relation. Read-only viewers (e.g. a
// company observer) only see progress; participants can add/toggle/remove.
export function GoalsPanel({ relationId, readOnly = false }: { relationId: string; readOnly?: boolean }) {
  const t = useT();
  const locale = useLocale();
  const [goals, setGoals] = useState<Goal[]>([]);
  const [title, setTitle] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [saving, setSaving] = useState(false);
  const [sortOrder, setSortOrder] = useState<'newest' | 'oldest'>('newest');
  const [showArchive, setShowArchive] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editDueDate, setEditDueDate] = useState('');
  const [editSaving, setEditSaving] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/goals?relationId=${relationId}`);
    if (res.ok) setGoals((await res.json()).goals ?? []);
  }, [relationId]);
  useEffect(() => { load(); }, [load]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setSaving(true);
    try {
      const res = await fetch('/api/goals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relationId, title, dueDate: dueDate || undefined }),
      });
      if (res.ok) { setTitle(''); setDueDate(''); await load(); }
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (g: Goal) => {
    await fetch(`/api/goals/${g.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: g.status === 'DONE' ? 'OPEN' : 'DONE' }),
    });
    await load();
  };

  const remove = async (g: Goal) => {
    if (!window.confirm(t.goals.confirmDelete.replace('{title}', g.title))) return;
    await fetch(`/api/goals/${g.id}`, { method: 'DELETE' });
    await load();
  };

  const startEdit = (g: Goal) => {
    setEditingId(g.id);
    setEditTitle(g.title);
    setEditDueDate(g.dueDate ? g.dueDate.slice(0, 10) : '');
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditTitle('');
    setEditDueDate('');
  };

  const saveEdit = async (g: Goal) => {
    if (!editTitle.trim()) return;
    setEditSaving(true);
    try {
      const res = await fetch(`/api/goals/${g.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: editTitle.trim(), dueDate: editDueDate || null }),
      });
      if (res.ok) {
        cancelEdit();
        await load();
      }
    } finally {
      setEditSaving(false);
    }
  };

  const done = goals.filter((g) => g.status === 'DONE').length;
  const progress = goals.length ? Math.round((done / goals.length) * 100) : 0;
  const sortGoals = (items: Goal[]) => [...items].sort((a, b) => {
    const difference = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    return sortOrder === 'oldest' ? difference : -difference;
  });
  const activeGoals = sortGoals(goals.filter((g) => g.status === 'OPEN'));
  const archivedGoals = sortGoals(goals.filter((g) => g.status === 'DONE'));

  const goalRow = (g: Goal, editable: boolean) => (
    <div key={g.id} data-testid={`goal-${g.id}`} className="flex items-center gap-2 text-sm">
      <button
        onClick={() => !readOnly && toggle(g)}
        disabled={readOnly || editingId === g.id}
        aria-label={g.status === 'DONE' ? t.goals.markOpen : t.goals.markDone}
        className={g.status === 'DONE' ? 'text-green-600' : 'text-gray-300 hover:text-gray-500'}
      >
        {g.status === 'DONE' ? <Check className="h-4 w-4" /> : <Circle className="h-4 w-4" />}
      </button>
      <span className="flex-1 min-w-0">
        {editingId === g.id ? (
          <div className="space-y-2">
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-[160px] flex-1">
                <Input
                  label={t.goals.goalTitle}
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="w-40">
                <Input
                  label={t.goals.dueDate}
                  type="date"
                  value={editDueDate}
                  onChange={(e) => setEditDueDate(e.target.value)}
                />
              </div>
            </div>
            <div className="flex gap-2">
              <Button type="button" size="sm" loading={editSaving} disabled={!editTitle.trim()} onClick={() => saveEdit(g)}>
                {t.common.save}
              </Button>
              <Button type="button" size="sm" variant="outline" disabled={editSaving} onClick={cancelEdit}>
                {t.common.cancel}
              </Button>
            </div>
          </div>
        ) : (
          <>
            <span className={g.status === 'DONE' ? 'line-through text-gray-400' : 'text-gray-800'}>{g.title}</span>
            <span className="flex flex-wrap items-center gap-x-2 text-[11px] text-gray-400">
              {g.createdByRole === 'MENTOR' && <span>{t.goals.byMentor}</span>}
              {g.createdByRole === 'MENTEE' && <span>{t.goals.byMentee}</span>}
              <span>· {formatDate(g.createdAt, locale)}</span>
              {g.dueDate && <span>· {t.goals.dueDate}: {formatDate(g.dueDate, locale)}</span>}
            </span>
          </>
        )}
      </span>
      {!readOnly && editingId !== g.id && (
        <>
          {editable && (
            <button type="button" onClick={() => startEdit(g)} aria-label={t.common.edit} className="text-gray-300 hover:text-blue-600">
              <Pencil className="h-4 w-4" />
            </button>
          )}
        <button onClick={() => remove(g)} aria-label={t.common.delete} className="text-gray-300 hover:text-red-600">
          <Trash2 className="h-4 w-4" />
        </button>
        </>
      )}
    </div>
  );

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle>{t.goals.title}</CardTitle>
          <div className="flex items-center gap-2">
            <div className="w-36">
              <Select
                aria-label={t.goals.sortBy}
                value={sortOrder}
                onChange={(e) => setSortOrder(e.target.value as 'newest' | 'oldest')}
                className="py-1.5 pl-3 pr-8"
                options={[
                  { value: 'newest', label: t.goals.newestFirst },
                  { value: 'oldest', label: t.goals.oldestFirst },
                ]}
              />
            </div>
            <Button
              type="button"
              size="sm"
              variant={showArchive ? 'secondary' : 'outline'}
              aria-expanded={showArchive}
              onClick={() => setShowArchive((shown) => !shown)}
            >
              <Archive className="h-4 w-4" />
              {t.goals.archive}
            </Button>
          </div>
        </div>
      </CardHeader>

      {goals.length > 0 && (
        <div className="mb-4">
          <div className="flex justify-between text-xs text-gray-500 mb-1">
            <span>{done}/{goals.length} {t.goals.completed}</span>
            <span>{progress}%</span>
          </div>
          <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
            <div className="h-full bg-green-500 transition-all" style={{ width: `${progress}%` }} />
          </div>
        </div>
      )}

      {activeGoals.length === 0 ? (
        <p className="text-sm text-gray-400 mb-4">{goals.length === 0 ? t.goals.none : t.goals.noneActive}</p>
      ) : (
        <div data-testid="active-goals" className="space-y-2 mb-4">
          {activeGoals.map((g) => goalRow(g, true))}
        </div>
      )}

      {!readOnly && (
        <form onSubmit={add} className="flex flex-wrap items-end gap-2">
          <div className="flex-1 min-w-[160px]"><Input label={t.goals.newGoal} value={title} onChange={(e) => setTitle(e.target.value)} /></div>
          <div className="w-40"><Input label={t.goals.dueDate} type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></div>
          <Button type="submit" size="sm" loading={saving} disabled={!title.trim()}>{t.goals.add}</Button>
        </form>
      )}

      {showArchive && (
        <section className="mt-6 border-t border-gray-200 pt-4" data-testid="goals-archive">
          <h3 className="mb-3 text-sm font-semibold text-gray-700">{t.goals.archive}</h3>
          {archivedGoals.length === 0
            ? <p className="text-sm text-gray-400">{t.goals.noneArchived}</p>
            : <div className="space-y-2">{archivedGoals.map((g) => goalRow(g, false))}</div>}
        </section>
      )}
    </Card>
  );
}
