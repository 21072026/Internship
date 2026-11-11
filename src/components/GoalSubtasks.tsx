'use client';

import { useState } from 'react';
import { Check, Circle, Trash2 } from 'lucide-react';
import { useT } from '@/i18n/client';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { TEXT_LIMITS } from '@/lib/textLimits';

export interface GoalSubtask {
  id: string;
  title: string;
  done: boolean;
  archived: boolean;
  assignee: { id: string; fullName: string } | null;
  canCheck: boolean;
  canEdit: boolean;
  canDelete: boolean;
}

/**
 * A goal's steps (#1860). Each one is a to-do on its assignee's /todos list —
 * ticked here or there, it is the same row, and the goal's progress is derived
 * from them by the server. Changes go through /api/project-tasks/[taskId],
 * the one write path of a to-do.
 */
export function GoalSubtasks({ goalId, subtasks, readOnly, onChanged }: { goalId: string; subtasks: GoalSubtask[]; readOnly: boolean; onChanged: () => void }) {
  const t = useT();
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<Response>) {
    setBusy(true);
    try {
      await fn();
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    void run(async () => {
      const res = await fetch(`/api/goals/${goalId}/subtasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim() }),
      });
      if (res.ok) setTitle('');
      return res;
    });
  };

  if (readOnly && subtasks.length === 0) return null;
  return (
    <div className="mt-1.5 space-y-1" data-testid={`goalsteps-${goalId}`}>
      {subtasks.length > 0 && (
        <ul className="space-y-1">
          {subtasks.map((s) => (
            <li key={s.id} className="flex items-center gap-2 text-xs" data-testid={`goalstep-${s.id}`} data-done={s.done ? '1' : '0'}>
              <button
                type="button"
                disabled={readOnly || !s.canCheck || busy}
                aria-label={s.done ? t.goals.markOpen : t.goals.markDone}
                onClick={() =>
                  void run(() =>
                    fetch(`/api/project-tasks/${s.id}`, {
                      method: 'PATCH',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ done: !s.done }),
                    }),
                  )
                }
                className={s.done ? 'text-green-600' : 'text-gray-300 hover:text-gray-500'}
              >
                {s.done ? <Check className="h-3.5 w-3.5" /> : <Circle className="h-3.5 w-3.5" />}
              </button>
              <span className={`flex-1 ${s.done ? 'line-through text-gray-400' : 'text-gray-700'}`}>{s.title}</span>
              {s.assignee && <span className="text-[11px] text-gray-400">{s.assignee.fullName}</span>}
              {!readOnly && s.canDelete && (
                <button
                  type="button"
                  disabled={busy}
                  aria-label={t.common.delete}
                  onClick={() => void run(() => fetch(`/api/project-tasks/${s.id}`, { method: 'DELETE' }))}
                  className="text-gray-300 hover:text-red-600"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!readOnly && (
        <form onSubmit={add} className="flex items-end gap-2">
          <div className="flex-1">
            <Input
              aria-label={t.goals.newStep}
              placeholder={t.goals.newStep}
              value={title}
              maxLength={TEXT_LIMITS.todoTitle}
              onChange={(e) => setTitle(e.target.value)}
              data-testid={`goalstep-input-${goalId}`}
              className="py-1 text-xs"
            />
          </div>
          <Button type="submit" size="sm" variant="outline" loading={busy} disabled={!title.trim()} data-testid={`goalstep-add-${goalId}`}>
            {t.goals.addStep}
          </Button>
        </form>
      )}
    </div>
  );
}
