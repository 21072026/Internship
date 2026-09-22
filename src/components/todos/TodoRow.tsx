'use client';

import { useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, Archive, ArchiveRestore, CalendarClock, Check, CheckCircle2, Circle, Pencil, Trash2, X } from 'lucide-react';
import { useT, useLocale } from '@/i18n/client';
import { formatDate } from '@/lib/relativeTime';
import { resolveTemplateTitle } from '@/lib/goalTemplates';
import { TEXT_LIMITS } from '@/lib/textLimits';
import { taskDueState, type TaskDueTone } from '@/lib/taskDue';
import type { Locale } from '@/i18n/config';

// One line of a to-do list (#1113).
//
// The wording is resolved *here*, not on the server: a to-do that came from the
// shared pool carries its template, so it reads in the viewer's own language and
// follows any later rewording. A hand-written one is its own text and never moves.
//
// The due-date chip (#2440) is classified here for the same reason: `taskDue.ts`
// decides what "late" means, and it means it on the READER's calendar day.

// The stage clock's tones, on purpose (`StageClockChip`): the same red already
// means "past the date somebody agreed to" on the board and in the aging report,
// and a to-do is not a different kind of late. `bg-*-50` + `text-*-700` is the
// pairing globals.css rescues from dark-on-dark under html.dark, so no per-
// element dark: utility is needed.
//
// The tone is never the only thing said — every chip also carries the words
// ("Overdue", "Due today", "Due 21.09.2026"). Colour alone is WCAG 1.4.1, and
// the repo's a11y gate is there to keep it that way.
const DUE_TONE_CLASS: Record<TaskDueTone, string> = {
  overdue: 'text-red-700 bg-red-50 border-red-200',
  today: 'text-amber-700 bg-amber-50 border-amber-200',
  upcoming: 'text-gray-500 bg-gray-50 border-gray-200',
};

export interface Todo {
  id: string;
  title: string;
  done: boolean;
  doneAt: string | null;
  archived: boolean;
  createdAt: string;
  dueDate: string | null;
  project: { id: string; name: string } | null;
  author: { id: string; fullName: string } | null;
  assignee?: { id: string; fullName: string } | null;
  template: { id: string; title: string; translations: Partial<Record<Locale, string>>; archived: boolean } | null;
  shared: boolean;
  canCheck: boolean;
  canEdit: boolean;
  canDelete: boolean;
}

export function todoText(todo: Todo, locale: string): string {
  return todo.template ? resolveTemplateTitle(todo.template, locale) : todo.title;
}

/** The `YYYY-MM-DD` an <input type="date"> wants, read off the stored day's UTC parts. */
export function dueDateInputValue(todo: Todo): string {
  return todo.dueDate ? todo.dueDate.slice(0, 10) : '';
}

export function TodoRow({
  todo,
  busy,
  showAssignee = false,
  onToggle,
  onArchive,
  onSave,
  onDelete,
}: {
  todo: Todo;
  busy: boolean;
  /** Team list: every row belongs to somebody else, so say whose it is. */
  showAssignee?: boolean;
  onToggle?: (todo: Todo) => void;
  onArchive?: (todo: Todo, archived: boolean) => void;
  /** Wording and date are edited together, and saved in one request. */
  onSave?: (todo: Todo, patch: { title: string; dueDate: string | null }) => Promise<boolean>;
  onDelete?: (todo: Todo) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [dueDraft, setDueDraft] = useState('');
  const text = todoText(todo, locale);
  const due = taskDueState(todo.dueDate);
  // The stored value names a UTC day (src/lib/taskDue.ts § rule 2), so it is
  // read back on that clock — otherwise everyone west of UTC sees it a day early.
  const dueLabel = todo.dueDate ? formatDate(todo.dueDate, locale, { timeZone: 'UTC' }) : '';
  // A finished to-do keeps its date and drops the alarm: it is no longer late.
  const dueTone = todo.done ? 'upcoming' : (due?.tone ?? 'upcoming');
  const dueLate = !todo.done && due?.overdue === true;
  const dueText = dueLate
    ? t.todos.overdueBadge
    : dueTone === 'today' && !todo.done
      ? t.todos.dueToday
      : t.todos.dueOn.replace('{date}', dueLabel);

  const startEdit = () => {
    setDraft(text);
    setDueDraft(dueDateInputValue(todo));
    setEditing(true);
  };

  const save = async () => {
    const next = draft.trim();
    if (!next || !onSave) return setEditing(false);
    // An emptied date field clears the date — null, not "today".
    if (await onSave(todo, { title: next, dueDate: dueDraft || null })) setEditing(false);
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
          maxLength={TEXT_LIMITS.todoTitle}
          data-testid={`todo-edit-input-${todo.id}`}
          className="w-full min-w-0 rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900 sm:flex-1"
        />
        <input
          type="date"
          value={dueDraft}
          onChange={(e) => setDueDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); save(); }
            if (e.key === 'Escape') setEditing(false);
          }}
          aria-label={t.todos.dueDateLabel}
          title={t.todos.dueDateLabel}
          data-testid={`todo-edit-due-${todo.id}`}
          className="w-full shrink-0 rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900 sm:w-40"
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
        {/* The date, in words and in a tone — never in a tone alone (WCAG 1.4.1).
            The visible text is short; the tooltip and the screen reader get the
            sentence, exactly as StageClockChip does it. */}
        {due && (
          <span
            data-testid={`todo-due-${todo.id}`}
            data-due-tone={dueTone}
            title={dueLate ? t.todos.overdueTitle.replace('{date}', dueLabel) : t.todos.dueOn.replace('{date}', dueLabel)}
            aria-label={dueLate ? t.todos.overdueTitle.replace('{date}', dueLabel) : t.todos.dueOn.replace('{date}', dueLabel)}
            className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${DUE_TONE_CLASS[dueTone]}`}
          >
            {dueLate ? <AlertTriangle className="h-3 w-3" aria-hidden /> : <CalendarClock className="h-3 w-3" aria-hidden />}
            {dueText}
          </span>
        )}
        {showAssignee && todo.assignee && (
          <span className="shrink-0 text-xs text-gray-400" data-testid={`todo-assignee-${todo.id}`}>
            {t.todos.forPerson.replace('{name}', todo.assignee.fullName)}
          </span>
        )}
        {todo.done && todo.doneAt && (
          <span className="shrink-0 whitespace-nowrap text-xs text-gray-400">{formatDate(todo.doneAt, locale)}</span>
        )}
      </span>

      <span className="ml-auto flex shrink-0 items-center gap-2">
        {onSave && todo.canEdit && (
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
