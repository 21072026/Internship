'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, Circle, Trash2 } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { useT, useLocale } from '@/i18n/client';

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

  const done = goals.filter((g) => g.status === 'DONE').length;
  const progress = goals.length ? Math.round((done / goals.length) * 100) : 0;

  return (
    <Card>
      <CardHeader><CardTitle>{t.goals.title}</CardTitle></CardHeader>

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

      {goals.length === 0 ? (
        <p className="text-sm text-gray-400 mb-4">{t.goals.none}</p>
      ) : (
        <div className="space-y-2 mb-4">
          {goals.map((g) => (
            <div key={g.id} data-testid={`goal-${g.id}`} className="flex items-center gap-2 text-sm">
              <button
                onClick={() => !readOnly && toggle(g)}
                disabled={readOnly}
                aria-label={g.status === 'DONE' ? t.goals.markOpen : t.goals.markDone}
                className={g.status === 'DONE' ? 'text-green-600' : 'text-gray-300 hover:text-gray-500'}
              >
                {g.status === 'DONE' ? <Check className="h-4 w-4" /> : <Circle className="h-4 w-4" />}
              </button>
              <span className="flex-1 min-w-0">
                <span className={g.status === 'DONE' ? 'line-through text-gray-400' : 'text-gray-800'}>{g.title}</span>
                <span className="flex flex-wrap items-center gap-x-2 text-[11px] text-gray-400">
                  {g.createdByRole === 'MENTOR' && <span>{t.goals.byMentor}</span>}
                  {g.createdByRole === 'MENTEE' && <span>{t.goals.byMentee}</span>}
                  <span>· {new Date(g.createdAt).toLocaleDateString(locale)}</span>
                  {g.dueDate && <span>· {t.goals.dueDate}: {new Date(g.dueDate).toLocaleDateString(locale)}</span>}
                </span>
              </span>
              {!readOnly && (
                <button onClick={() => remove(g)} aria-label={t.common.delete} className="text-gray-300 hover:text-red-600">
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {!readOnly && (
        <form onSubmit={add} className="flex flex-wrap items-end gap-2">
          <div className="flex-1 min-w-[160px]"><Input label={t.goals.newGoal} value={title} onChange={(e) => setTitle(e.target.value)} /></div>
          <div className="w-40"><Input label={t.goals.dueDate} type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></div>
          <Button type="submit" size="sm" loading={saving} disabled={!title.trim()}>{t.goals.add}</Button>
        </form>
      )}
    </Card>
  );
}
