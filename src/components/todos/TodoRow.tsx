'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Archive, ArchiveRestore, Check, CheckCircle2, Circle, Pencil, Trash2, X } from 'lucide-react';
import { useT, useLocale } from '@/i18n/client';
import { formatDate } from '@/lib/relativeTime';
import { resolveTemplateTitle } from '@/lib/goalTemplates';
import type { Locale } from '@/i18n/config';

// One line of a to-do list (#1113).
//
// The wording is resolved *here*, not on the server: a to-do that came from the
// shared pool carries its template, so it reads in the viewer's own language and
// follows any later rewording. A hand-written one is its own text and never moves.

export interface Todo {
  id: string;
  title: string;
  done: boolean;
  doneAt: string | null;
  archived: boolean;
  createdAt: string;
  project: { id: string; name: string } | null;
  author: { id: string; fullName: string } | null;
  template: { id: string; title: string; translations: Partial<Record<Locale, string>>; archived: boolean } | null;
  shared: boolean;
  canCheck: boolean;
  canEdit: boolean;
  canDelete: boolean;
}

export function todoText(todo: Todo, locale: string): string {
  return todo.template ? resolveTemplateTitle(todo.template, locale) : todo.title;
}

export function TodoRow({
  todo,
  busy,
  onToggle,
  onArchive,
  onRename,
  onDelete,
}: {
  todo: Todo;
  busy: boolean;
  onToggle?: (todo: Todo) => void;
  onArchive?: (todo: Todo, archived: boolean) => void;
  onRename?: (todo: Todo, title: string) => Promise<boolean>;
  onDelete?: (todo: Todo) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const text = todoText(todo, locale);

  const startEdit = () => {
    setDraft(text);
    setEditing(true);
  };

  const save = async () => {
    const next = draft.trim();
    if (!next || !onRename) return setEditing(false);
    if (await onRename(todo, next)) setEditing(false);
  };

  if (editing) {
    return (
      <li className="flex flex-col gap-2 py-1.5 sm:flex-row sm:items-center" data-testid={`todo-${todo.id}`}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); save(); }
            if (e.key === 'Escape') setEditing(false);
          }}
          data-testid={`todo-edit-input-${todo.id}`}
          className="w-full min-w-0 rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900 sm:flex-1"
        />
        <span className="flex shrink-0 items-center gap-3">
          <button type="button" onClick={() => setEditing(false)} className="inline-flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600">
            <X className="h-3.5 w-3.5" /> {t.common.cancel}
          </button>
          <button type="button" onClick={save} disabled={busy} className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline" data-testid={`todo-save-${todo.id}`}>
            <Check className="h-3.5 w-3.5" /> {t.common.save}
          </button>
        </span>
      </li>
    );
  }

  return (
    <li className="group flex flex-wrap items-start gap-x-2 gap-y-1 py-1.5 text-sm" data-testid={`todo-${todo.id}`}>
      {onToggle && todo.canCheck ? (
        <button
          type="button"
          onClick={() => onToggle(todo)}
          disabled={busy}
          aria-label={todo.done ? t.todos.markOpen : t.todos.markDone}
          data-testid={`todo-check-${todo.id}`}
          className="mt-0.5 shrink-0"
        >
          {todo.done ? <CheckCircle2 className="h-4 w-4 text-green-500" /> : <Circle className="h-4 w-4 text-gray-300" />}
        </button>
      ) : todo.done ? (
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-500" />
      ) : (
        <Circle className="mt-0.5 h-4 w-4 shrink-0 text-gray-300" />
      )}

      <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
        <span className={`min-w-0 break-words ${todo.done ? 'text-gray-400 line-through' : 'text-gray-700 dark:text-gray-200'}`}>
          {text}
        </span>
        {todo.shared && (
          <span
            className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] uppercase text-gray-500 dark:bg-gray-800"
            title={t.todos.sharedHint}
            data-testid={`todo-shared-${todo.id}`}
          >
            {t.todos.sharedBadge}
          </span>
        )}
        {todo.project && (
          <Link href={`/projects/${todo.project.id}`} className="shrink-0 text-xs text-gray-400 hover:text-blue-600">
            {t.todos.fromProject.replace('{project}', todo.project.name)}
          </Link>
        )}
        {todo.author && (
          <span className="shrink-0 text-xs text-gray-400">
            {t.todos.fromPerson.replace('{name}', todo.author.fullName)}
          </span>
        )}
        {todo.done && todo.doneAt && (
          <span className="shrink-0 whitespace-nowrap text-xs text-gray-400">{formatDate(todo.doneAt, locale)}</span>
        )}
      </span>

      <span className="ml-auto flex shrink-0 items-center gap-2">
        {onRename && todo.canEdit && (
          <button type="button" onClick={startEdit} aria-label={t.common.edit} className="text-gray-300 hover:text-blue-600" data-testid={`todo-edit-${todo.id}`}>
            <Pencil className="h-3.5 w-3.5" />
          </button>
        )}
        {/* Putting a to-do away is the one thing everyone may do with their own,
            shared or not: the record stays, the list gets shorter. */}
        {onArchive && todo.canCheck && (
          <button
            type="button"
            onClick={() => onArchive(todo, !todo.archived)}
            disabled={busy}
            aria-label={todo.archived ? t.todos.unarchive : t.todos.archive}
            title={todo.archived ? t.todos.unarchive : t.todos.archive}
            className="text-gray-300 hover:text-gray-600"
            data-testid={`todo-archive-${todo.id}`}
          >
            {todo.archived ? <ArchiveRestore className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}
          </button>
        )}
        {onDelete && todo.canDelete && (
          <button type="button" onClick={() => onDelete(todo)} disabled={busy} aria-label={t.common.delete} className="text-gray-300 hover:text-red-600" data-testid={`todo-delete-${todo.id}`}>
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </span>
    </li>
  );
}
