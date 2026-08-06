'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Check, Circle, Hand, Trash2, Send, Plus, Pencil, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useT, useLocale } from '@/i18n/client';
import { locales, type Locale } from '@/i18n/config';
import { resolveTemplateTitle } from '@/lib/goalTemplates';
import type { TeamMember } from '@/lib/projectTeam';

// Project goals, per person (#51).
//
// The task list used to be a single project-wide checklist with no owner: only
// the project owner had a UI for it, so for everyone else it was decoration. Now
// a goal can belong to someone (the mentor hands it over, or a member claims an
// unassigned one), and the person it belongs to can tick it off.
//
// The template pool is the other half: the shortlist a lead hands to whoever
// joins next. It holds what someone put there on purpose — this project's own
// templates plus the admin-managed shared ones — and nothing else. It used to
// absorb every goal written on the project, which meant the goals just handed out
// came straight back as templates, once per language, and the same wording piled
// up round after round (#1113).

interface Task {
  id: string;
  title: string;
  done: boolean;
  assigneeId: string | null;
  assignee?: { id: string; fullName: string } | null;
  // Set when the goal came from the pool: the wording is read from here, in the
  // viewer's language, so a reworded template reaches everyone who has it.
  template?: { id: string; title: string; translations: Partial<Record<Locale, string>> } | null;
}

interface Template {
  id: string;
  title: string;
  // The goal in each language it has been written in; read in the viewer's.
  translations: Partial<Record<Locale, string>>;
  useCount: number;
  // Part of the admin-managed pool every project sees — not this project's to
  // reword or remove.
  shared: boolean;
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
  const locale = useLocale();
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
  const [editingTemplate, setEditingTemplate] = useState<string | null>(null);
  const [templateNew, setTemplateNew] = useState('');
  const [templateDraft, setTemplateDraft] = useState<Partial<Record<Locale, string>>>({});

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

  const unassigned = useMemo(() => tasks.filter((tk) => !tk.assigneeId), [tasks]);
  const assigned = useMemo(() => tasks.filter((tk) => tk.assigneeId), [tasks]);
  const assignable = useMemo(() => team.filter((m) => m.role === 'MENTEE'), [team]);

  const toggle = (task: Task) =>
    call(`/api/project-tasks/${task.id}`, 'PATCH', { done: !task.done }, task.id);
  const claim = (task: Task) =>
    call(`/api/project-tasks/${task.id}`, 'PATCH', { assigneeId: myId }, task.id);
  const release = (task: Task) =>
    call(`/api/project-tasks/${task.id}`, 'PATCH', { assigneeId: null }, task.id);
  // A goal from the pool reads its wording from the template, in this viewer's
  // language; a hand-written one is its own text.
  const taskTitle = (task: Task) => (task.template ? resolveTemplateTitle(task.template, locale) : task.title);

  const remove = (task: Task) => {
    if (!window.confirm(t.projects.confirmDeleteTask.replace('{title}', taskTitle(task)))) return;
    return call(`/api/project-tasks/${task.id}`, 'DELETE', undefined, task.id);
  };

  const addGoal = async () => {
    const title = draft.trim();
    if (!title) return;
    if (await call(`/api/projects/${projectId}/tasks`, 'POST', { title, assigneeId: draftAssignee || null }, 'add')) {
      setDraft('');
    }
  };

  const startEditTemplate = (tpl: Template) => {
    setEditingTemplate(tpl.id);
    // A template captured before the pool was multilingual only has `title`;
    // seed the editor with it so saving does not drop the wording.
    setTemplateDraft(Object.keys(tpl.translations).length > 0 ? tpl.translations : { en: tpl.title });
  };

  const saveTemplate = async (tpl: Template) => {
    if (!locales.some((l) => templateDraft[l]?.trim())) return;
    if (
      await call(`/api/projects/${projectId}/task-templates`, 'PATCH', { id: tpl.id, translations: templateDraft }, tpl.id)
    ) {
      setEditingTemplate(null);
    }
  };

  // Add a wording to this project's own pool, in the language the lead is using;
  // the edit form below fills in the other two.
  const addTemplate = async () => {
    const text = templateNew.trim();
    if (!text) return;
    if (
      await call(
        `/api/projects/${projectId}/task-templates`,
        'POST',
        { translations: { [locale]: text } },
        'new-template'
      )
    ) {
      setTemplateNew('');
    }
  };

  const removeTemplate = (tpl: Template) => {
    if (!window.confirm(t.goalTemplateAdmin.confirmDelete.replace('{title}', resolveTemplateTitle(tpl, locale)))) return;
    return call(`/api/projects/${projectId}/task-templates`, 'DELETE', { id: tpl.id }, tpl.id);
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
      <span className={`min-w-0 break-words ${task.done ? 'line-through text-gray-400' : 'text-gray-700 dark:text-gray-200'}`}>
        {taskTitle(task)}
      </span>
      {task.template && (
        <span
          className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] uppercase text-gray-500 dark:bg-gray-800"
          title={t.todos.sharedHint}
        >
          {t.todos.sharedBadge}
        </span>
      )}
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

      {unassigned.length > 0 && (
        <div>
          <h3 className="mb-1.5 text-sm font-semibold text-gray-900 dark:text-gray-100">{t.projects.openGoals}</h3>
          <p className="mb-1.5 text-xs text-gray-400">{t.projects.openGoalsHint}</p>
          <ul className="space-y-1">
            {unassigned.map((tk) => row(tk, { canTick: canLead, canClaim: isMember }))}
          </ul>
        </div>
      )}

      {/* A personal goal belongs to the person, so it is listed on their profile
          (PersonProjectGoals) instead of here in front of the whole team. Only
          the count stays, so a lead can see the project is not idle. */}
      {assigned.length > 0 && (
        <p className="text-xs text-gray-400" data-testid="assigned-goals-count">
          {t.projects.assignedGoalsCount.replace('{n}', String(assigned.length))}
        </p>
      )}

      {tasks.length === 0 && <p className="text-sm text-gray-400">{t.projects.noGoals}</p>}

      {canLead && (
        <div className="space-y-3 border-t border-gray-100 pt-3 dark:border-gray-800">
          <p className="text-xs text-gray-400">{t.projects.assignedGoalsHint}</p>
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
              title={t.projects.assignedGoalsHint}
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
                {/* The pool is filled on purpose now, so it needs its own input:
                    writing a goal for someone no longer puts it here by itself. */}
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <input
                    value={templateNew}
                    onChange={(e) => setTemplateNew(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTemplate(); } }}
                    placeholder={t.projects.addTemplate}
                    data-testid="new-project-template"
                    className="w-full min-w-0 rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900 sm:flex-1"
                  />
                  <Button type="button" size="sm" variant="outline" className="w-full sm:w-auto" loading={busy === 'new-template'} onClick={addTemplate} data-testid="add-project-template">
                    <Plus className="mr-1 h-3.5 w-3.5" /> {t.projects.add}
                  </Button>
                </div>
                {templates.length === 0 ? (
                  <p className="text-xs text-gray-400">{t.projects.noTemplates}</p>
                ) : (
                  <ul className="space-y-1">
                    {templates.map((tpl) =>
                      editingTemplate === tpl.id ? (
                        // Reword one of this project's own templates, per language.
                        <li key={tpl.id} className="space-y-1.5 rounded-lg bg-gray-50 p-2 dark:bg-gray-800/50">
                          {locales.map((l) => (
                            <input
                              key={l}
                              value={templateDraft[l] ?? ''}
                              onChange={(e) => setTemplateDraft((prev) => ({ ...prev, [l]: e.target.value }))}
                              placeholder={t.goalTemplateAdmin.langLabel.replace('{lang}', l.toUpperCase())}
                              data-testid={`edit-template-${tpl.id}-${l}`}
                              className="w-full min-w-0 rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900"
                            />
                          ))}
                          <div className="flex justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => setEditingTemplate(null)}
                              className="inline-flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600"
                            >
                              <X className="h-3.5 w-3.5" /> {t.common.cancel}
                            </button>
                            <button
                              type="button"
                              onClick={() => saveTemplate(tpl)}
                              disabled={busy === tpl.id}
                              className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
                              data-testid={`save-template-${tpl.id}`}
                            >
                              <Check className="h-3.5 w-3.5" /> {t.common.save}
                            </button>
                          </div>
                        </li>
                      ) : (
                        <li key={tpl.id} className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={picked.includes(tpl.id)}
                            onChange={(e) =>
                              setPicked((prev) => (e.target.checked ? [...prev, tpl.id] : prev.filter((id) => id !== tpl.id)))
                            }
                            data-testid={`template-${tpl.id}`}
                          />
                          <span className="min-w-0 break-words text-gray-700 dark:text-gray-200">
                            {resolveTemplateTitle(tpl, locale)}
                          </span>
                          {tpl.shared && (
                            <span
                              className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] uppercase text-gray-500 dark:bg-gray-800"
                              title={t.goalTemplateAdmin.sharedHint}
                            >
                              {t.goalTemplateAdmin.sharedBadge}
                            </span>
                          )}
                          {tpl.useCount > 0 && (
                            <span className="shrink-0 text-xs text-gray-400">· {t.projects.templateUsed.replace('{n}', String(tpl.useCount))}</span>
                          )}
                          {/* Only this project's own templates are editable here. */}
                          {!tpl.shared && (
                            <span className="ml-auto flex shrink-0 items-center gap-2">
                              <button
                                type="button"
                                onClick={() => startEditTemplate(tpl)}
                                aria-label={t.common.edit}
                                className="text-gray-300 hover:text-blue-600"
                                data-testid={`edit-template-${tpl.id}`}
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => removeTemplate(tpl)}
                                disabled={busy === tpl.id}
                                aria-label={t.common.delete}
                                className="text-gray-300 hover:text-red-600"
                                data-testid={`delete-template-${tpl.id}`}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </span>
                          )}
                        </li>
                      )
                    )}
                  </ul>
                )}
                <p className="text-xs text-gray-400">{t.projects.templateRetired}</p>
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
