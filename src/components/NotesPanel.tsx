'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Trash2, Lock, Pencil, PictureInPicture2, ListChecks } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Textarea } from '@/components/ui/Textarea';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useT } from '@/i18n/client';
import { useToast } from '@/components/ui/Toast';
import { useFloatingNotes } from '@/components/meeting/FloatingNotes';

type Category = 'MEETING' | 'FEEDBACK' | 'TASKS' | 'PERSONAL';
const CATEGORIES: Category[] = ['MEETING', 'FEEDBACK', 'TASKS', 'PERSONAL'];

interface Note {
  id: string;
  body: string;
  category: Category;
  updatedAt: string;
  // Set when the note was taken in a meeting (#1056). relationId/projectId say
  // what a line from it could become (#1059).
  meeting?: { id: string; title: string; relationId: string | null; projectId: string | null } | null;
}

// Where a line from this note would go: a goal on the mentorship, a task on the
// project, or nowhere (a chat meeting, or no meeting at all).
function targetOf(n: Note): 'GOAL' | 'PROJECT_TASK' | null {
  if (n.meeting?.relationId) return 'GOAL';
  if (n.meeting?.projectId) return 'PROJECT_TASK';
  return null;
}

// Private personal notes — visible only to the owner.
export function NotesPanel() {
  const t = useT();
  const toast = useToast();
  const { open: openNotesWindow } = useFloatingNotes();
  const [notes, setNotes] = useState<Note[]>([]);
  const [body, setBody] = useState('');
  const [category, setCategory] = useState<Category>('PERSONAL');
  const [categoryFilter, setCategoryFilter] = useState<'ALL' | Category>('ALL');
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState('');
  const [convertingId, setConvertingId] = useState<string | null>(null);
  const [convertBusy, setConvertBusy] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const editSavingRef = useRef(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch('/api/notes');
    if (res.ok) setNotes((await res.json()).notes ?? []);
  }, []);
  useEffect(() => { load(); }, [load]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!body.trim()) return;
    setSaving(true);
    try {
      const res = await fetch('/api/notes', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body, category }),
      });
      if (res.ok) { setBody(''); setCategory('PERSONAL'); await load(); toast(t.portal.notes.added); }
    } finally {
      setSaving(false);
    }
  };

  const remove = (id: string) => setDeleteId(id);

  const confirmRemove = async () => {
    if (!deleteId || deleting) return;
    setDeleting(true);
    try {
      await fetch(`/api/notes/${deleteId}`, { method: 'DELETE' });
      await load();
      toast(t.portal.notes.deleted);
    } finally {
      setDeleting(false);
      setDeleteId(null);
    }
  };

  const startEdit = (note: Note) => {
    if (editSavingRef.current) return;
    setEditingId(note.id);
    setEditBody(note.body);
  };
  const cancelEdit = () => { setEditingId(null); setEditBody(''); };

  // One line of a note becomes a goal or a project task (#1059). The server
  // re-checks that the line is really in the note and that this user may write
  // to the target, then marks the line so it can't be converted twice.
  const convertLine = async (note: Note, line: string) => {
    const target = targetOf(note);
    if (!target) return;
    setConvertBusy(true);
    try {
      const res = await fetch(`/api/notes/${note.id}/convert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          line,
          target,
          ...(target === 'GOAL'
            ? { relationId: note.meeting?.relationId }
            : { projectId: note.meeting?.projectId }),
        }),
      });
      if (!res.ok) {
        toast(res.status === 409 ? t.portal.notes.alreadyConverted : t.common.error, 'error');
        return;
      }
      toast(target === 'GOAL' ? t.portal.notes.goalCreated : t.portal.notes.taskCreated);
      await load();
    } catch {
      toast(t.common.error, 'error');
    } finally {
      setConvertBusy(false);
    }
  };
  const saveEdit = async (id: string) => {
    const trimmedBody = editBody.trim();
    if (!trimmedBody || editSavingRef.current) return;
    editSavingRef.current = true;
    setEditSaving(true);
    try {
      const res = await fetch(`/api/notes/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: trimmedBody }),
      });
      if (!res.ok) { toast(t.common.error); return; }
      cancelEdit();
      await load();
      toast(t.portal.notes.updated);
    } catch {
      toast(t.common.error);
    } finally {
      editSavingRef.current = false;
      setEditSaving(false);
    }
  };

  const shown = categoryFilter === 'ALL' ? notes : notes.filter((n) => n.category === categoryFilter);

  return (
    <>
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Lock className="h-4 w-4 text-gray-400" />
          {t.portal.notes.title}
          {/* Opens the floating window (#1057). Must be a click handler that
              calls straight through — the window API needs the live gesture. */}
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="ml-auto"
            data-testid="open-notes-window"
            onClick={() => void openNotesWindow({ title: t.meetings.notesWindow.title })}
          >
            <PictureInPicture2 className="h-4 w-4" />
            {t.meetings.notesWindow.open}
          </Button>
        </CardTitle>
      </CardHeader>
      <p className="text-xs text-gray-400 mb-3">{t.portal.notes.privateHint}</p>

      <form onSubmit={add} className="space-y-2 mb-4">
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={2}
          maxLength={3000}
          placeholder={t.portal.notes.placeholder}
          showCounter
        />
        <div data-testid="note-category-picker" className="flex flex-wrap items-center gap-1.5">
          {CATEGORIES.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCategory(c)}
              className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                category === c ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {t.portal.notes.categories[c]}
            </button>
          ))}
        </div>
        <Button type="submit" size="sm" loading={saving} disabled={!body.trim()}>{t.portal.notes.add}</Button>
      </form>

      {notes.length > 0 && (
        <div data-testid="note-category-filter" className="flex flex-wrap items-center gap-1.5 mb-3">
          <button
            onClick={() => setCategoryFilter('ALL')}
            className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
              categoryFilter === 'ALL' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {t.usersAdmin.all}
          </button>
          {CATEGORIES.map((c) => (
            <button
              key={c}
              onClick={() => setCategoryFilter(c)}
              className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                categoryFilter === c ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {t.portal.notes.categories[c]}
            </button>
          ))}
        </div>
      )}

      {notes.length === 0 ? (
        <p className="text-sm text-gray-400">{t.portal.notes.none}</p>
      ) : shown.length === 0 ? (
        <p className="text-sm text-gray-400">{t.portal.notes.noneInCategory}</p>
      ) : (
        <div className="space-y-2">
          {shown.map((n) => (
            <div key={n.id} data-testid={`note-${n.id}`} className="group flex items-start justify-between gap-2 rounded-lg border border-gray-100 p-2.5">
              <div className="flex-1 min-w-0">
                <div className="mb-1 flex flex-wrap items-center gap-1">
                  <Badge variant="default" className="text-[10px]">{t.portal.notes.categories[n.category]}</Badge>
                  {/* Which room this was written in (#1056) — without it a
                      MEETING note is just an undated wall of text. */}
                  {n.meeting && (
                    <Badge variant="info" className="text-[10px]" data-testid={`note-meeting-${n.id}`}>
                      {n.meeting.title}
                    </Badge>
                  )}
                </div>
                {editingId === n.id ? (
                  <div>
                    <Textarea
                      value={editBody}
                      onChange={(e) => setEditBody(e.target.value)}
                      rows={3}
                      maxLength={3000}
                      autoFocus
                      aria-label={t.portal.notes.placeholder}
                      showCounter
                      className="mb-2"
                    />
                    <div className="flex gap-2">
                      <Button type="button" size="sm" loading={editSaving} disabled={!editBody.trim() || editSaving} onClick={() => saveEdit(n.id)}>{t.common.save}</Button>
                      <Button type="button" size="sm" variant="outline" disabled={editSaving} onClick={cancelEdit}>{t.common.cancel}</Button>
                    </div>
                  </div>
                ) : convertingId === n.id ? (
                  // Line-by-line, because "we'll do X" is one sentence inside a
                  // wall of text — converting the whole note would be useless.
                  <div className="space-y-1" data-testid={`note-convert-${n.id}`}>
                    {n.body.split('\n').map((line, i) => {
                      const text = line.trim();
                      if (!text) return null;
                      const already = text.startsWith('✓');
                      return (
                        <div key={i} className="flex items-start gap-2">
                          <p className={`flex-1 text-sm ${already ? 'text-gray-400 line-through' : 'text-gray-700'}`}>
                            {text}
                          </p>
                          {!already && (
                            <button
                              type="button"
                              disabled={convertBusy}
                              onClick={() => convertLine(n, text)}
                              className="flex-shrink-0 rounded px-2 py-0.5 text-xs font-medium text-blue-600 hover:bg-blue-50 disabled:opacity-50 dark:hover:bg-blue-950"
                            >
                              {targetOf(n) === 'GOAL' ? t.portal.notes.toGoal : t.portal.notes.toTask}
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-sm text-gray-700 whitespace-pre-wrap break-words">{n.body}</p>
                )}
              </div>
              {editingId !== n.id && (
                <div className="flex items-center gap-2">
                  {/* Only offered when there is somewhere for the work to go —
                      a mentorship (goal) or a project (task). A chat meeting has
                      neither, so the button would only ever fail. */}
                  {targetOf(n) && (
                    <button
                      type="button"
                      onClick={() => setConvertingId((cur) => (cur === n.id ? null : n.id))}
                      aria-label={t.portal.notes.convert}
                      title={t.portal.notes.convert}
                      data-testid={`note-convert-toggle-${n.id}`}
                      className={`flex-shrink-0 ${convertingId === n.id ? 'text-blue-600' : 'text-gray-300 hover:text-blue-600'}`}
                    >
                      <ListChecks className="h-4 w-4" />
                    </button>
                  )}
                  <button type="button" disabled={editSaving} onClick={() => startEdit(n)} aria-label={t.common.edit} className="text-gray-300 hover:text-blue-600 flex-shrink-0 disabled:cursor-not-allowed disabled:opacity-50">
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button type="button" onClick={() => remove(n.id)} aria-label={t.common.delete} className="text-gray-300 hover:text-red-600 flex-shrink-0">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
    <ConfirmDialog
      open={deleteId !== null}
      message={t.common.confirmDelete}
      cancelLabel={t.common.cancel}
      confirmLabel={t.common.delete}
      variant="danger"
      loading={deleting}
      onConfirm={confirmRemove}
      onCancel={() => setDeleteId(null)}
    />
    </>
  );
}
