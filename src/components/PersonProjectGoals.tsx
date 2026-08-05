'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, Circle } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card';
import { useT, useLocale } from '@/i18n/client';
import { formatDate } from '@/lib/relativeTime';

// The project goals that belong to one person, grouped by project.
//
// A goal handed to someone is theirs, so this is where it lives: their own
// profile (and, for a mentor or admin, the profile they are looking at). The
// project page shows only the unassigned goals anyone may claim — before this,
// every personal goal was listed there for the whole team to read.
//
// Ticking follows PATCH /api/project-tasks/[taskId]: your own goals are yours to
// tick, a project lead may tick anyone's, everyone else reads.

interface Goal {
  id: string;
  title: string;
  done: boolean;
  doneAt: string | null;
  project: { id: string; name: string };
  canEdit: boolean;
}

export function PersonProjectGoals({ userId, className }: { userId?: string; className?: string }) {
  const t = useT();
  const locale = useLocale();
  const [goals, setGoals] = useState<Goal[]>([]);
  const [isOwner, setIsOwner] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    const res = await fetch(`/api/project-goals${userId ? `?userId=${encodeURIComponent(userId)}` : ''}`);
    if (res.ok) {
      const d = await res.json();
      setGoals(d.goals ?? []);
      setIsOwner(Boolean(d.viewerIsOwner));
    }
    setLoaded(true);
  }, [userId]);

  useEffect(() => { load(); }, [load]);

  const patch = async (goal: Goal, body: Record<string, unknown>) => {
    setBusy(goal.id);
    try {
      await fetch(`/api/project-tasks/${goal.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      await load();
    } finally {
      setBusy('');
    }
  };

  const toggle = (goal: Goal) => patch(goal, { done: !goal.done });
  // Hand a goal back to the project's open pool — the project page offered this
  // on your own row before personal goals moved here.
  const release = (goal: Goal) => patch(goal, { assigneeId: null });

  const byProject = useMemo(() => {
    const groups = new Map<string, { name: string; goals: Goal[] }>();
    for (const goal of goals) {
      const group = groups.get(goal.project.id) ?? { name: goal.project.name, goals: [] };
      group.goals.push(goal);
      groups.set(goal.project.id, group);
    }
    return [...groups.entries()];
  }, [goals]);

  // Nothing assigned and nothing loading: stay out of the way instead of
  // adding an empty card to a page that already has plenty.
  if (!loaded || goals.length === 0) return null;

  const doneCount = goals.filter((g) => g.done).length;

  return (
    <Card className={className} data-testid="person-project-goals">
      <CardHeader>
        <CardTitle>{t.projectGoals.title}</CardTitle>
        <CardDescription>
          {t.projectGoals.progress.replace('{done}', String(doneCount)).replace('{total}', String(goals.length))}
        </CardDescription>
      </CardHeader>
      <div className="space-y-4">
        {byProject.map(([projectId, group]) => (
          <div key={projectId}>
            <Link
              href={`/projects/${projectId}`}
              className="text-xs font-semibold uppercase tracking-wide text-gray-500 hover:text-blue-600"
            >
              {group.name}
            </Link>
            <ul className="mt-1.5 space-y-1">
              {group.goals.map((goal) => (
                <li key={goal.id} className="flex items-start gap-2 text-sm" data-testid={`project-goal-${goal.id}`}>
                  {goal.canEdit ? (
                    <button
                      type="button"
                      onClick={() => toggle(goal)}
                      disabled={busy === goal.id}
                      aria-label={goal.done ? t.goals.markOpen : t.goals.markDone}
                      className="mt-0.5 shrink-0"
                    >
                      {goal.done ? (
                        <CheckCircle2 className="h-4 w-4 text-green-500" />
                      ) : (
                        <Circle className="h-4 w-4 text-gray-300" />
                      )}
                    </button>
                  ) : goal.done ? (
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-500" />
                  ) : (
                    <Circle className="mt-0.5 h-4 w-4 shrink-0 text-gray-300" />
                  )}
                  <span className={`min-w-0 break-words ${goal.done ? 'text-gray-400 line-through' : 'text-gray-700 dark:text-gray-200'}`}>
                    {goal.title}
                    {goal.done && goal.doneAt && (
                      <span className="ml-1.5 whitespace-nowrap text-xs text-gray-400">
                        {formatDate(goal.doneAt, locale)}
                      </span>
                    )}
                  </span>
                  {isOwner && goal.canEdit && !goal.done && (
                    <button
                      type="button"
                      onClick={() => release(goal)}
                      disabled={busy === goal.id}
                      className="ml-auto shrink-0 text-xs text-gray-400 hover:text-gray-600"
                    >
                      {t.projects.releaseGoal}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Card>
  );
}
