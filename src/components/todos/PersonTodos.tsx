'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plus, Send } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useT, useLocale } from '@/i18n/client';
import { resolveTemplateTitle } from '@/lib/goalTemplates';
import type { Locale } from '@/i18n/config';
import { TodoRow, type Todo } from '@/components/todos/TodoRow';

// One person's to-do list as their mentor (or an admin) sees it, plus the box to
// put something on it (#1113).
//
// Two things a mentor could not do before: hand someone a to-do without a project
// to hang it on, and see everything they are carrying in one list. Both live here.
// What they *cannot* see is a line the person wrote for themselves — the API
// leaves those out of someone else's view.
//
// A to-do sent from the shared pool keeps a reference to it, so rewording the
// pool entry later reaches this person too, in their own language.

interface PoolTemplate {
  id: string;
  title: string;
  translations: Partial<Record<Locale, string>>;
  useCount: number;
}

export function PersonTodos({
  userId,
  fullName,
  className,
}: {
  userId: string;
  fullName?: string;
  className?: string;
}) {
  const t = useT();
  const locale = useLocale();
  const [todos, setTodos] = useState<Todo[]>([]);
  const [pool, setPool] = useState<PoolTemplate[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [showPool, setShowPool] = useState(false);
  const [draft, setDraft] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const name = fullName ?? '';

  const load = useCallback(async () => {
    const res = await fetch(`/api/todos?userId=${encodeURIComponent(userId)}`);
    if (res.ok) setTodos((await res.json()).todos ?? []);
    setLoaded(true);
  }, [userId]);

  const loadPool = useCallback(async () => {
    const res = await fetch('/api/todos/templates');
    if (res.ok) setPool((await res.json()).templates ?? []);
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (showPool && pool.length === 0) loadPool(); }, [showPool, pool.length, loadPool]);

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

  const assign = async () => {
    const title = draft.trim();
    if (!title) return;
    if (await call('/api/todos', 'POST', { title, assigneeId: userId }, 'assign')) setDraft('');
  };

  const sendPicked = async () => {
    if (picked.length === 0) return;
    if (await call('/api/todos', 'POST', { templateIds: picked, assigneeId: userId }, 'pool')) setPicked([]);
  };

  const toggle = (todo: Todo) => call(`/api/project-tasks/${todo.id}`, 'PATCH', { done: !todo.done }, todo.id);
  const remove = (todo: Todo) => {
    if (!window.confirm(t.todos.confirmDelete.replace('{title}', todo.title))) return;
    return call(`/api/project-tasks/${todo.id}`, 'DELETE', undefined, todo.id);
  };

  if (!loaded) return null;

  const doneCount = todos.filter((x) => x.done).length;

  return (
    <Card className={className} data-testid="person-todos">
      <CardHeader>
        <CardTitle>{t.todos.personTitle}</CardTitle>
        <CardDescription>
          {todos.length > 0
            ? t.todos.done.replace('{done}', String(doneCount)).replace('{total}', String(todos.length))
            : t.todos.personNone}
        </CardDescription>
      </CardHeader>

      {todos.length > 0 && (
        <ul className="mb-4 divide-y divide-gray-100 dark:divide-gray-800">
          {todos.map((todo) => (
            <TodoRow key={todo.id} todo={todo} busy={busy === todo.id} onToggle={toggle} onDelete={remove} />
          ))}
        </ul>
      )}

      <div className="space-y-3 border-t border-gray-100 pt-3 dark:border-gray-800">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); assign(); } }}
            placeholder={t.todos.assignPlaceholder.replace('{name}', name)}
            data-testid="assign-todo-input"
            className="w-full min-w-0 rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900 sm:flex-1"
          />
          <Button type="button" size="sm" variant="outline" className="w-full sm:w-auto" loading={busy === 'assign'} onClick={assign} data-testid="assign-todo">
            <Plus className="mr-1 h-3.5 w-3.5" /> {t.todos.assign}
          </Button>
        </div>

        <button
          type="button"
          onClick={() => setShowPool((v) => !v)}
          className="text-sm font-medium text-gray-700 hover:text-blue-600 dark:text-gray-200"
          data-testid="toggle-todo-pool"
        >
          {t.todos.fromPool}
        </button>

        {showPool && (
          <div className="space-y-2 rounded-xl border border-gray-200 p-3 dark:border-gray-800">
            <p className="text-xs text-gray-500">{t.todos.poolHint}</p>
            {pool.length === 0 ? (
              <p className="text-xs text-gray-400">{t.todos.poolEmpty}</p>
            ) : (
              <ul className="space-y-1">
                {pool.map((tpl) => (
                  <li key={tpl.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={picked.includes(tpl.id)}
                      onChange={(e) => setPicked((prev) => (e.target.checked ? [...prev, tpl.id] : prev.filter((id) => id !== tpl.id)))}
                      data-testid={`pool-template-${tpl.id}`}
                    />
                    <span className="min-w-0 break-words text-gray-700 dark:text-gray-200">
                      {resolveTemplateTitle(tpl, locale)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" loading={busy === 'pool'} disabled={picked.length === 0} onClick={sendPicked} data-testid="send-pool-todos">
                <Send className="mr-1 h-3.5 w-3.5" /> {t.todos.send}
              </Button>
              {pool.length > 0 && (
                <button type="button" onClick={() => setPicked(pool.map((x) => x.id))} className="text-xs text-blue-600 hover:underline">
                  {t.todos.selectAll}
                </button>
              )}
            </div>
          </div>
        )}

        {error && <p className="text-xs text-red-600">{error}</p>}
      </div>
    </Card>
  );
}
