'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Circle, Hand, Trash2, Send, Plus } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';
import type { TeamMember } from '@/lib/projectTeam';

// Project goals, per person (#51).
//
// The task list used to be a single project-wide checklist with no owner: only
// the project owner had a UI for it, so for everyone else it was decoration. Now
// a goal can belong to someone (the mentor hands it over, or a member claims an
// unassigned one), and the person it belongs to can tick it off.
//
// The template pool is the other half: every goal ever written here is kept, so
// the standard starter set can be handed to whoever joins next in one click.

interface Task {
  id: string;
  title: string;
  done: boolean;
  assigneeId: string | null;
  assignee?: { id: string; fullName: string } | null;
}

interface Template {
  id: string;
  title: string;
  useCount: number;
}

export function ProjectGoals({
  projectId,
  myId,
  canLead,
  isMember,
}: {
  projectId: string;
  myId: string;
  canLead: boolean;
  isMember: boolean;
}) {
  const t = useT();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const [draftAssignee, setDraftAssignee] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [templateTarget, setTemplateTarget] = useState('');
  const [showTemplates, setShowTemplates] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/projects/${projectId}`);
    if (!res.ok) { setLoading(false); return; }
    const { project } = await res.json();
    setTasks(project?.tasks ?? []);
    setTeam(project?.team ?? []);
    setLoading(false);
  }, [projectId]);

  const loadTemplates = useCallback(async () => {
    const res = await fetch(`/api/projects/${projectId}/task-templates`);
    if (!res.ok) return;
    const d = await res.json();
    setTemplates(d.templates ?? []);
  }, [projectId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (canLead) loadTemplates(); }, [canLead, loadTemplates]);

  const call = async (url: string, method: string, body?: unknown, key = 'x') => {
    setBusy(key);
    setError('');
    try {
      const res = await fetch(url, {
        method,
        ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || t.common.error);
      }
      await load();
      if (canLead) await loadTemplates();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : t.common.error);
      return false;
    } finally {
      setBusy('');
    }
  };

  const mine = useMemo(() => tasks.filter((tk) => tk.assigneeId === myId), [tasks, myId]);
  const unassigned = useMemo(() => tasks.filter((tk) => !tk.assigneeId), [tasks]);
  const others = useMemo(() => tasks.filter((tk) => tk.assigneeId && tk.assigneeId !== myId), [tasks, myId]);
  const assignable = useMemo(() => team.filter((m) => m.role === 'MENTEE'), [team]);

  const toggle = (task: Task) =>
    call(`/api/project-tasks/${task.id}`, 'PATCH', { done: !task.done }, task.id);
  const claim = (task: Task) =>
    call(`/api/project-tasks/${task.id}`, 'PATCH', { assigneeId: myId }, task.id);
  const release = (task: Task) =>
    call(`/api/project-tasks/${task.id}`, 'PATCH', { assigneeId: null }, task.id);
  const remove = (task: Task) => {
    if (!window.confirm(t.projects.confirmDeleteTask.replace('{title}', task.title))) return;
    return call(`/api/project-tasks/${task.id}`, 'DELETE', undefined, task.id);
  };

  const addGoal = async () => {
    const title = draft.trim();
    if (!title) return;
    if (await call(`/api/projects/${projectId}/tasks`, 'POST', { title, assigneeId: draftAssignee || null }, 'add')) {
      setDraft('');
    }
  };

  const sendTemplates = async () => {
    if (picked.length === 0 || !templateTarget) return;
    if (
      await call(
        `/api/projects/${projectId}/tasks`,
        'POST',
        { templateIds: picked, assigneeId: templateTarget },
        'templates'
      )
    ) {
      setPicked([]);
    }
  };

  const row = (task: Task, opts: { canTick: boolean; canClaim?: boolean; canRelease?: boolean }) => (
    <li key={task.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm" data-testid={`goal-${task.id}`}>
      {opts.canTick ? (
        <button type="button" onClick={() => toggle(task)} disabled={busy === task.id} aria-label={task.done ? t.goals.markOpen : t.goals.markDone}>
          {task.done ? <CheckCircle2 className="h-4 w-4 text-green-500" /> : <Circle className="h-4 w-4 text-gray-300" />}
        </button>
      ) : task.done ? (
        <CheckCircle2 className="h-4 w-4 shrink-0 text-green-500" />
      ) : (
        <Circle className="h-4 w-4 shrink-0 text-gray-300" />
      )}
      <span className={`min-w-0 break-words ${task.done ? 'line-through text-gray-400' : 'text-gray-700 dark:text-gray-200'}`}>{task.title}</span>
      {task.assignee && task.assigneeId !== myId && (
        <span className="text-xs text-gray-400">· {task.assignee.fullName}</span>
      )}
      {opts.canClaim && (
        <button type="button" onClick={() => claim(task)} disabled={busy === task.id} className="ml-auto inline-flex items-center gap-1 text-xs text-blue-600 hover:underline" data-testid={`claim-${task.id}`}>
          <Hand className="h-3.5 w-3.5" /> {t.projects.claimGoal}
        </button>
      )}
      {opts.canRelease && (
        <button type="button" onClick={() => release(task)} disabled={busy === task.id} className="ml-auto text-xs text-gray-400 hover:text-gray-600">
          {t.projects.releaseGoal}
        </button>
      )}
      {canLead && (
        <button type="button" onClick={() => remove(task)} aria-label={t.common.delete} className="text-gray-300 hover:text-red-600">
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
    </li>
  );

  if (loading) return null;

  const doneCount = tasks.filter((tk) => tk.done).length;
  const pct = tasks.length ? Math.round((doneCount / tasks.length) * 100) : 0;

  return (
    <div className="space-y-4" data-testid="project-goals">
      <div>
        <div className="mb-1 flex justify-between text-xs text-gray-500">
          <span>{doneCount}/{tasks.length} {t.projects.tasksDone}</span>
          <span>{pct}%</span>
        </div>
        <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
          <div className="h-full bg-green-500" style={{ width: `${pct}%` }} />
        </div>
      </div>

      {mine.length > 0 && (
        <div>
          <h3 className="mb-1.5 text-sm font-semibold text-gray-900 dark:text-gray-100">{t.projects.myGoals}</h3>
          <ul className="space-y-1">{mine.map((tk) => row(tk, { canTick: true, canRelease: !canLead }))}</ul>
        </div>
      )}

      {unassigned.length > 0 && (
        <div>
          <h3 className="mb-1.5 text-sm font-semibold text-gray-900 dark:text-gray-100">{t.projects.openGoals}</h3>
          <p className="mb-1.5 text-xs text-gray-400">{t.projects.openGoalsHint}</p>
          <ul className="space-y-1">
            {unassigned.map((tk) => row(tk, { canTick: canLead, canClaim: isMember }))}
          </ul>
        </div>
      )}

      {others.length > 0 && (
        <div>
          <h3 className="mb-1.5 text-sm font-semibold text-gray-900 dark:text-gray-100">{t.projects.teamGoals}</h3>
          <ul className="space-y-1">{others.map((tk) => row(tk, { canTick: canLead }))}</ul>
        </div>
      )}

      {tasks.length === 0 && <p className="text-sm text-gray-400">{t.projects.noGoals}</p>}

      {canLead && (
        <div className="space-y-3 border-t border-gray-100 pt-3 dark:border-gray-800">
          {/* Stacked below sm: an input sharing a row with a select and a button
              collapses to a few characters wide on a phone (#51 follow-up). */}
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addGoal(); } }}
              placeholder={t.projects.addTask}
              data-testid="goal-input"
              className="w-full min-w-0 rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900 sm:flex-1"
            />
            <select
              value={draftAssignee}
              onChange={(e) => setDraftAssignee(e.target.value)}
              data-testid="goal-assignee"
              className="w-full min-w-0 rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900 sm:w-auto"
            >
              <option value="">{t.projects.unassigned}</option>
              {assignable.map((m) => (
                <option key={m.id} value={m.id}>{m.fullName}</option>
              ))}
            </select>
            <Button type="button" size="sm" variant="outline" className="w-full sm:w-auto" loading={busy === 'add'} onClick={addGoal}>
              <Plus className="mr-1 h-3.5 w-3.5" /> {t.projects.add}
            </Button>
          </div>

          <div>
            <button
              type="button"
              onClick={() => setShowTemplates((v) => !v)}
              className="text-sm font-medium text-gray-700 hover:text-blue-600 dark:text-gray-200"
              data-testid="toggle-templates"
            >
              {t.projects.goalTemplates} ({templates.length})
            </button>
            {showTemplates && (
              <div className="mt-2 space-y-2 rounded-xl border border-gray-200 p-3 dark:border-gray-800">
                <p className="text-xs text-gray-500">{t.projects.goalTemplatesHint}</p>
                {templates.length === 0 ? (
                  <p className="text-xs text-gray-400">{t.projects.noTemplates}</p>
                ) : (
                  <ul className="space-y-1">
                    {templates.map((tpl) => (
                      <li key={tpl.id} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={picked.includes(tpl.id)}
                          onChange={(e) =>
                            setPicked((prev) => (e.target.checked ? [...prev, tpl.id] : prev.filter((id) => id !== tpl.id)))
                          }
                          data-testid={`template-${tpl.id}`}
                        />
                        <span className="text-gray-700 dark:text-gray-200">{tpl.title}</span>
                        {tpl.useCount > 0 && (
                          <span className="text-xs text-gray-400">· {t.projects.templateUsed.replace('{n}', String(tpl.useCount))}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                  <select
                    value={templateTarget}
                    onChange={(e) => setTemplateTarget(e.target.value)}
                    data-testid="template-target"
                    className="w-full min-w-0 rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900 sm:w-auto"
                  >
                    <option value="">{t.projects.selectMember}</option>
                    {assignable.map((m) => (
                      <option key={m.id} value={m.id}>{m.fullName}</option>
                    ))}
                  </select>
                  <Button
                    type="button"
                    size="sm"
                    loading={busy === 'templates'}
                    disabled={picked.length === 0 || !templateTarget}
                    onClick={sendTemplates}
                    data-testid="send-templates"
                  >
                    <Send className="mr-1 h-3.5 w-3.5" /> {t.projects.sendGoals}
                  </Button>
                  {picked.length > 0 && (
                    <button type="button" onClick={() => setPicked(templates.map((x) => x.id))} className="text-xs text-blue-600 hover:underline">
                      {t.projects.selectAll}
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
