'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Hand, ListChecks, Plus } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { useT, useLocale } from '@/i18n/client';
import { useToast } from '@/components/ui/Toast';
import { useAnnounce } from '@/components/ui/LiveRegion';
import { useCharacterCounter } from '@/hooks/useCharacterCounter';
import { apiErrorMessage } from '@/lib/apiErrorMessage';
import { TEXT_LIMITS } from '@/lib/textLimits';
import { TodoRow, todoText, type Todo } from '@/components/todos/TodoRow';
import { countOverdueTasks } from '@/lib/taskDue';

// One person's whole to-do list (#1113).
//
// Before this, the same kind of row was read in two places and neither was
// "your list": a to-do a mentor handed over sat on the profile page among the
// address fields, a project's goals sat on the project page, and a line you
// wanted to write yourself had nowhere to go. Here they are together —
// what someone gave you, what your projects need, and what you added — with the
// finished ones one click away in the archive.

// Whose list is on screen. The team view (#2440) is the SAME page, one fetch
// further: an admin's organisation or a mentor's own mentees, read-only, so
// "who is late" does not need a second to-dos page to answer.
type View = 'mine' | 'team';

export function MyTodos({ myId, role }: { myId: string; role?: string }) {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const announce = useAnnounce();
  const [todos, setTodos] = useState<Todo[]>([]);
  const [open, setOpen] = useState<Todo[]>([]);
  const [archive, setArchive] = useState<Todo[]>([]);
  const [showArchive, setShowArchive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const [dueDraft, setDueDraft] = useState('');
  const [pendingDelete, setPendingDelete] = useState<{ id: string; title: string } | null>(null);
  const [view, setView] = useState<View>('mine');
  const [team, setTeam] = useState<Todo[]>([]);
  const [teamLoaded, setTeamLoaded] = useState(false);
  // ADMIN always, MENTOR for their own mentees — the same rule /api/todos
  // enforces; this only decides whether the switch is worth showing.
  const canSeeTeam = role === 'ADMIN' || role === 'MENTOR';

  const load = useCallback(async () => {
    const [active, past] = await Promise.all([fetch('/api/todos'), fetch('/api/todos?archived=1')]);
    if (active.ok) {
      const d = await active.json();
      setTodos(d.todos ?? []);
      setOpen(d.open ?? []);
    }
    if (past.ok) setArchive((await past.json()).todos ?? []);
    setLoading(false);
  }, []);

  const loadTeam = useCallback(async () => {
    const res = await fetch('/api/todos?scope=team');
    if (res.ok) setTeam((await res.json()).todos ?? []);
    setTeamLoaded(true);
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (view === 'team' && canSeeTeam) loadTeam(); }, [view, canSeeTeam, loadTeam]);

  const call = async (url: string, method: string, body: unknown, key: string) => {
    setBusy(key);
    setError('');
    try {
      const res = await fetch(url, {
        method,
        ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
      });
      // Never `body.error`: every 4xx on these routes carries a hardcoded English
      // literal ('Forbidden', 'Validation failed', 'Nothing to create'), and this
      // now goes into a toast rather than a small line — so a Turkish admin would
      // get an English one, centre stage. Same stance as every other call site
      // in the app: the status is what gets translated (@/lib/apiErrorMessage).
      if (!res.ok) throw new Error(apiErrorMessage(res, t.common, t.common.error));
      await load();
      return true;
    } catch (e) {
      // Say it out loud (#1433). The inline line below the list is easy to miss
      // — it sits under the archive toggle — and adding a to-do that failed on
      // the server used to look exactly like adding one that worked.
      const message = e instanceof Error ? e.message : t.common.error;
      setError(message);
      toast(message, 'error');
      return false;
    } finally {
      setBusy('');
    }
  };

  const add = async () => {
    const title = draft.trim();
    if (!title) return;
    // An empty date field is no date at all, never "today".
    if (await call('/api/todos', 'POST', { title, dueDate: dueDraft || null }, 'add')) {
      setDraft('');
      setDueDraft('');
    }
  };

  const toggle = (todo: Todo) => call(`/api/project-tasks/${todo.id}`, 'PATCH', { done: !todo.done }, todo.id);
  const setArchived = (todo: Todo, archived: boolean) =>
    call(`/api/project-tasks/${todo.id}`, 'PATCH', { archived }, todo.id);
  // Wording and date travel together: one row, one edit, one request.
  const save = (todo: Todo, patch: { title: string; dueDate: string | null }) =>
    call(`/api/project-tasks/${todo.id}`, 'PATCH', patch, todo.id);
  const remove = (todo: Todo) => setPendingDelete({ id: todo.id, title: todoText(todo, locale) });

  const confirmRemove = async () => {
    if (!pendingDelete || busy === pendingDelete.id) return;
    await call(`/api/project-tasks/${pendingDelete.id}`, 'DELETE', undefined, pendingDelete.id);
    setPendingDelete(null);
  };
  const claim = (todo: Todo) => call(`/api/project-tasks/${todo.id}`, 'PATCH', { assigneeId: myId }, todo.id);

  const doneCount = useMemo(() => todos.filter((x) => x.done).length, [todos]);
  // The counter tile. What it counts is decided in one place (src/lib/taskDue.ts):
  // open, dated, and due on a day BEFORE today — a to-do due today is not late.
  const shown = view === 'team' ? team : todos;
  const overdueCount = useMemo(() => countOverdueTasks(showArchive ? [] : shown), [shown, showArchive]);
  // ProjectTask.title is VARCHAR(191). The counter only appears once the draft
  // is close to that, so the box stays quiet for the one-line to-dos that are
  // the normal case, and the limit is visible exactly when it starts to matter.
  const draftCounter = useCharacterCounter(draft, TEXT_LIMITS.todoTitle);

  // WCAG 4.1.3, the rule `Textarea` states and implements for the same widget:
  // the counter is a visual-only cue, so a screen-reader user pasting an
  // over-long line hears nothing while the field silently clips it. Announce the
  // two THRESHOLD CROSSINGS only — `state` changes at most twice per draft, so
  // this never speaks per keystroke, which would make the box unusable.
  const previousCounterState = useRef(draftCounter.state);
  useEffect(() => {
    const previous = previousCounterState.current;
    previousCounterState.current = draftCounter.state;
    if (previous === draftCounter.state) return;
    if (draftCounter.state === 'error') {
      announce(t.a11y.characterLimitReached, 'assertive');
    } else if (draftCounter.state === 'warning') {
      announce(t.a11y.charactersRemaining.replace('{count}', String(Math.max(0, draftCounter.remaining))));
    }
  }, [draftCounter.state, draftCounter.remaining, announce, t]);

  if (loading) {
    return (
      <Card>
        <SkeletonRows rows={4} />
      </Card>
    );
  }

  return (
    <>
    <div className="space-y-6" data-testid="my-todos">
      {(canSeeTeam || overdueCount > 0) && (
        <div className="flex flex-wrap items-center gap-2">
          {canSeeTeam && (
            <div className="flex gap-1 rounded-lg border border-gray-200 p-1 dark:border-gray-800">
              {(['mine', 'team'] as View[]).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setView(v)}
                  aria-pressed={view === v}
                  data-testid={`todos-view-${v}`}
                  className={`rounded-md px-3 py-1 text-xs font-medium ${
                    view === v
                      ? 'bg-blue-600 text-white'
                      : 'text-gray-600 hover:text-blue-600 dark:text-gray-300'
                  }`}
                >
                  {v === 'mine' ? t.todos.mineTab : t.todos.teamTab}
                </button>
              ))}
            </div>
          )}
          {/* The counter tile. The number is said in words next to it — the
              red is a second cue, never the only one (WCAG 1.4.1). */}
          {overdueCount > 0 && (
            <span
              data-testid="todo-overdue-count"
              data-overdue-count={overdueCount}
              className="inline-flex items-center gap-1.5 rounded-xl border border-red-200 bg-red-50 px-3 py-1.5 text-sm font-medium text-red-700"
            >
              <AlertTriangle className="h-4 w-4" aria-hidden />
              {t.todos.overdueCount.replace('{n}', String(overdueCount))}
            </span>
          )}
        </div>
      )}

      {view === 'team' ? (
        <Card data-testid="team-todos">
          <CardHeader>
            <CardTitle>{t.todos.teamTitle}</CardTitle>
            <CardDescription>{t.todos.teamHint}</CardDescription>
          </CardHeader>
          {!teamLoaded ? (
            <SkeletonRows rows={4} />
          ) : team.length === 0 ? (
            <p className="text-sm text-gray-400">{t.todos.teamEmpty}</p>
          ) : (
            <ul className="divide-y divide-gray-100 dark:divide-gray-800" data-testid="team-todo-list">
              {/* Read-only on purpose: this is the overview. A to-do is changed
                  where it lives — on the person, or on the list it came from. */}
              {team.map((todo) => (
                <TodoRow key={todo.id} todo={todo} busy={false} showAssignee />
              ))}
            </ul>
          )}
        </Card>
      ) : (
      <Card>
        <CardHeader>
          <CardTitle>{showArchive ? t.todos.archiveTitle : t.todos.mine}</CardTitle>
          <CardDescription>
            {showArchive
              ? t.todos.archiveHint
              : t.todos.done.replace('{done}', String(doneCount)).replace('{total}', String(todos.length))}
          </CardDescription>
        </CardHeader>

        {!showArchive && (
          <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="relative w-full min-w-0 sm:flex-1">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
                placeholder={t.todos.addPlaceholder}
                maxLength={TEXT_LIMITS.todoTitle}
                data-testid="todo-input"
                className="w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 pr-16 text-sm dark:border-gray-700 dark:bg-gray-900"
              />
              {draftCounter.state !== 'normal' && (
                <span
                  data-testid="todo-input-counter"
                  data-counter-state={draftCounter.state}
                  className={`pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 select-none text-xs font-medium ${
                    draftCounter.state === 'error'
                      ? 'text-red-600 dark:text-red-400'
                      : 'text-amber-600 dark:text-amber-400'
                  }`}
                >
                  {draftCounter.display}
                </span>
              )}
            </div>
            <input
              type="date"
              value={dueDraft}
              onChange={(e) => setDueDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
              aria-label={t.todos.dueDateLabel}
              title={t.todos.dueDateLabel}
              data-testid="todo-due-input"
              className="w-full shrink-0 rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900 sm:w-44"
            />
            <Button type="button" size="sm" variant="outline" className="w-full sm:w-auto" loading={busy === 'add'} onClick={add} data-testid="todo-add">
              <Plus className="mr-1 h-3.5 w-3.5" /> {t.todos.add}
            </Button>
          </div>
        )}

        {(showArchive ? archive : todos).length === 0 ? (
          showArchive ? (
            <p className="text-sm text-gray-400">{t.todos.archiveEmpty}</p>
          ) : (
            /* Role-neutral on purpose: everyone keeps the same list, and the
               next step is the input right above, not another route. */
            <EmptyState
              testId="my-todos"
              size="sm"
              icon={ListChecks}
              title={t.emptyStates.todos.title}
              body={t.emptyStates.todos.body}
            />
          )
        ) : (
          <ul className="divide-y divide-gray-100 dark:divide-gray-800" data-testid={showArchive ? 'todo-archive-list' : 'todo-list'}>
            {(showArchive ? archive : todos).map((todo) => (
              <TodoRow
                key={todo.id}
                todo={todo}
                busy={busy === todo.id}
                onToggle={toggle}
                onArchive={setArchived}
                onSave={save}
                onDelete={remove}
              />
            ))}
          </ul>
        )}

        <button
          type="button"
          onClick={() => setShowArchive((v) => !v)}
          className="mt-4 text-xs text-blue-600 hover:underline"
          data-testid="todo-archive-toggle"
        >
          {showArchive ? t.todos.hideArchive : t.todos.showArchive.replace('{n}', String(archive.length))}
        </button>

        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
      </Card>
      )}

      {/* Goals nobody on your projects has taken. Not yours until you say so, so
          they sit apart from the list above. */}
      {view === 'mine' && !showArchive && open.length > 0 && (
        <Card data-testid="open-project-goals">
          <CardHeader>
            <CardTitle>{t.todos.openProjectGoals}</CardTitle>
            <CardDescription>{t.todos.openHint}</CardDescription>
          </CardHeader>
          <ul className="divide-y divide-gray-100 dark:divide-gray-800">
            {open.map((todo) => (
              <li key={todo.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1.5 text-sm" data-testid={`open-todo-${todo.id}`}>
                <span className="min-w-0 break-words text-gray-700 dark:text-gray-200">{todoText(todo, locale)}</span>
                {todo.project && <span className="text-xs text-gray-400">{t.todos.fromProject.replace('{project}', todo.project.name)}</span>}
                <button
                  type="button"
                  onClick={() => claim(todo)}
                  disabled={busy === todo.id}
                  className="ml-auto inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
                  data-testid={`claim-todo-${todo.id}`}
                >
                  <Hand className="h-3.5 w-3.5" /> {t.todos.take}
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
    <ConfirmDialog
      open={pendingDelete !== null}
      message={pendingDelete ? t.todos.confirmDelete.replace('{title}', pendingDelete.title) : ''}
      cancelLabel={t.common.cancel}
      confirmLabel={t.common.delete}
      variant="danger"
      loading={pendingDelete ? busy === pendingDelete.id : false}
      onConfirm={confirmRemove}
      onCancel={() => setPendingDelete(null)}
    />
    </>
  );
}
