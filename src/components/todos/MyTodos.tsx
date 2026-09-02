'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Hand, ListChecks, Plus } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { useT, useLocale } from '@/i18n/client';
import { TodoRow, todoText, type Todo } from '@/components/todos/TodoRow';

// One person's whole to-do list (#1113).
//
// Before this, the same kind of row was read in two places and neither was
// "your list": a to-do a mentor handed over sat on the profile page among the
// address fields, a project's goals sat on the project page, and a line you
// wanted to write yourself had nowhere to go. Here they are together —
// what someone gave you, what your projects need, and what you added — with the
// finished ones one click away in the archive.

export function MyTodos({ myId }: { myId: string }) {
  const t = useT();
  const locale = useLocale();
  const [todos, setTodos] = useState<Todo[]>([]);
  const [open, setOpen] = useState<Todo[]>([]);
  const [archive, setArchive] = useState<Todo[]>([]);
  const [showArchive, setShowArchive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const [pendingDelete, setPendingDelete] = useState<{ id: string; title: string } | null>(null);

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

  useEffect(() => { load(); }, [load]);

  const call = async (url: string, method: string, body: unknown, key: string) => {
    setBusy(key);
    setError('');
    try {
      const res = await fetch(url, {
        method,
        ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || t.common.error);
      await load();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : t.common.error);
      return false;
    } finally {
      setBusy('');
    }
  };

  const add = async () => {
    const title = draft.trim();
    if (!title) return;
    if (await call('/api/todos', 'POST', { title }, 'add')) setDraft('');
  };

  const toggle = (todo: Todo) => call(`/api/project-tasks/${todo.id}`, 'PATCH', { done: !todo.done }, todo.id);
  const setArchived = (todo: Todo, archived: boolean) =>
    call(`/api/project-tasks/${todo.id}`, 'PATCH', { archived }, todo.id);
  const rename = (todo: Todo, title: string) => call(`/api/project-tasks/${todo.id}`, 'PATCH', { title }, todo.id);
  const remove = (todo: Todo) => setPendingDelete({ id: todo.id, title: todoText(todo, locale) });

  const confirmRemove = async () => {
    if (!pendingDelete || busy === pendingDelete.id) return;
    await call(`/api/project-tasks/${pendingDelete.id}`, 'DELETE', undefined, pendingDelete.id);
    setPendingDelete(null);
  };
  const claim = (todo: Todo) => call(`/api/project-tasks/${todo.id}`, 'PATCH', { assigneeId: myId }, todo.id);

  const doneCount = useMemo(() => todos.filter((x) => x.done).length, [todos]);

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
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
              placeholder={t.todos.addPlaceholder}
              data-testid="todo-input"
              className="w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900 sm:flex-1"
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
                onRename={rename}
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

      {/* Goals nobody on your projects has taken. Not yours until you say so, so
          they sit apart from the list above. */}
      {!showArchive && open.length > 0 && (
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
