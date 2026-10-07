'use client';

import { useCallback, useEffect, useState } from 'react';
import { History, NotebookPen, Pencil, Plus, X } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Textarea } from '@/components/ui/Textarea';
import { Button } from '@/components/ui/Button';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { useT } from '@/i18n/client';
import { useRealtime } from '@/hooks/useRealtime';
import { TEXT_LIMITS } from '@/lib/textLimits';

// The pair's shared minutes (#1847): what was said and agreed in a session,
// written by either seat and readable by both — the third note model beside
// the two private ones, which this panel never touches. Authorization lives in
// /api/session-notes; `readOnly` and the server's `writable` flag only hide the
// editor (an admin reads, an archived mentorship is read-only for the mentee).
// Every save writes a revision naming the editor; the trail is shown as a list,
// not a diff. Both seats see the same text without polling: writes publish a
// `sessionNote` realtime signal for the relation and the panel refetches.

interface Person {
  id: string;
  fullName: string;
}

interface Revision {
  id: string;
  author: Person | null;
  body: string;
  createdAt: string;
}

interface Note {
  id: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  createdBy: Person | null;
  lastEditedBy: Person | null;
  meeting: { id: string; title: string; scheduledAt: string | null } | null;
  revisions: Revision[];
}

export function SessionNotePanel({ relationId, readOnly = false }: { relationId: string; readOnly?: boolean }) {
  const t = useT();
  const L = t.sessionNotes;
  const [notes, setNotes] = useState<Note[]>([]);
  const [writable, setWritable] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState('');
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [shownRevision, setShownRevision] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const res = await fetch(`/api/session-notes?relationId=${relationId}`, { cache: 'no-store' });
    if (res.ok) {
      const body = await res.json();
      setNotes(body.notes ?? []);
      setWritable(body.writable === true);
    }
    setLoaded(true);
  }, [relationId]);
  useEffect(() => { load(); }, [load]);

  // The other seat saved: refetch, no refresh loop needed.
  useRealtime((signal) => {
    if (signal.type === 'tick' || (signal.type === 'sessionNote' && signal.relationId === relationId)) void load();
  });

  const canWrite = !readOnly && writable;

  const call = async (key: string, url: string, init: RequestInit) => {
    setBusy(key);
    setError('');
    try {
      const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...init });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.code === 'inactive_relation' ? L.archivedHint : body.code === 'admin_read_only' ? L.adminReadOnly : body.error ?? t.common.error);
        return null;
      }
      const body = await res.json().catch(() => ({}));
      await load();
      return body;
    } finally {
      setBusy('');
    }
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.trim()) return;
    const body = await call('create', '/api/session-notes', {
      method: 'POST',
      body: JSON.stringify({ relationId, body: draft.trim() }),
    });
    if (body) {
      setDraft('');
      setComposing(false);
    }
  };

  const startEdit = (note: Note) => {
    setEditingId(note.id);
    setEditBody(note.body);
    setError('');
  };

  const save = async (note: Note) => {
    if (!editBody.trim()) return;
    const body = await call(note.id, `/api/session-notes/${note.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ body: editBody.trim() }),
    });
    if (body) setEditingId(null);
  };

  return (
    <Card data-testid="session-note-panel">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle>{L.title}</CardTitle>
          {canWrite && !composing && (
            <Button type="button" size="sm" variant="outline" onClick={() => setComposing(true)} data-testid="session-note-new">
              <Plus className="h-4 w-4" />
              {L.newNote}
            </Button>
          )}
        </div>
      </CardHeader>

      {canWrite && composing && (
        <form onSubmit={create} className="mb-4 space-y-2" data-testid="session-note-compose">
          <label htmlFor={`session-note-draft-${relationId}`} className="block text-sm font-medium text-gray-700">
            {L.bodyLabel}
          </label>
          <Textarea
            id={`session-note-draft-${relationId}`}
            rows={5}
            value={draft}
            placeholder={L.placeholder}
            maxLength={TEXT_LIMITS.sessionNoteBody}
            showCounter
            onChange={(e) => setDraft(e.target.value)}
            data-testid="session-note-draft"
          />
          <div className="flex gap-2">
            <Button type="submit" size="sm" loading={busy === 'create'} disabled={!draft.trim()} data-testid="session-note-save">
              {L.save}
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={busy === 'create'} onClick={() => { setComposing(false); setDraft(''); }}>
              {t.common.cancel}
            </Button>
          </div>
        </form>
      )}

      {!loaded ? null : notes.length === 0 ? (
        <div className="flex items-start gap-3 text-sm text-gray-500">
          <NotebookPen className="mt-0.5 h-5 w-5 flex-shrink-0 text-gray-400" aria-hidden="true" />
          <div>
            <p className="font-medium text-gray-700">{L.noneYet}</p>
            <p className="mt-0.5">{canWrite ? L.noneYetHint : L.noneYetReadOnly}</p>
          </div>
        </div>
      ) : (
        <ul className="space-y-4" data-testid="session-notes">
          {notes.map((note) => (
            <li key={note.id} data-testid={`session-note-${note.id}`} className="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-500">
                {note.meeting && <span className="font-medium text-gray-700">{note.meeting.title}</span>}
                <span>
                  {L.writtenBy.replace('{name}', note.createdBy?.fullName ?? L.someone)} · <RelativeTime date={note.createdAt} />
                </span>
                {note.revisions.length > 1 && (
                  <span data-testid="session-note-edited">
                    · {L.editedBy.replace('{name}', note.lastEditedBy?.fullName ?? L.someone)} · <RelativeTime date={note.updatedAt} />
                  </span>
                )}
                <span className="ml-auto flex items-center gap-2">
                  {note.revisions.length > 1 && (
                    <button
                      type="button"
                      onClick={() => { setHistoryId(historyId === note.id ? null : note.id); setShownRevision(null); }}
                      aria-expanded={historyId === note.id}
                      className="inline-flex items-center gap-1 text-gray-400 hover:text-blue-600"
                      data-testid={`session-note-history-${note.id}`}
                    >
                      <History className="h-3.5 w-3.5" aria-hidden="true" />
                      {L.revisions.replace('{n}', String(note.revisions.length))}
                    </button>
                  )}
                  {canWrite && editingId !== note.id && (
                    <button
                      type="button"
                      onClick={() => startEdit(note)}
                      aria-label={t.common.edit}
                      className="text-gray-400 hover:text-blue-600"
                      data-testid={`session-note-edit-${note.id}`}
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                  )}
                </span>
              </div>

              {editingId === note.id ? (
                <div className="mt-2 space-y-2">
                  <Textarea
                    rows={6}
                    value={editBody}
                    maxLength={TEXT_LIMITS.sessionNoteBody}
                    showCounter
                    onChange={(e) => setEditBody(e.target.value)}
                    aria-label={L.bodyLabel}
                    data-testid={`session-note-editor-${note.id}`}
                  />
                  <div className="flex gap-2">
                    <Button type="button" size="sm" loading={busy === note.id} disabled={!editBody.trim()} onClick={() => save(note)} data-testid={`session-note-save-${note.id}`}>
                      {L.save}
                    </Button>
                    <Button type="button" size="sm" variant="outline" disabled={busy === note.id} onClick={() => setEditingId(null)}>
                      <X className="h-3.5 w-3.5" /> {t.common.cancel}
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="mt-2 whitespace-pre-line text-sm text-gray-800 dark:text-gray-100" data-testid={`session-note-body-${note.id}`}>
                  {note.body}
                </p>
              )}

              {historyId === note.id && (
                <div className="mt-3 border-t border-gray-100 pt-2 dark:border-gray-800" data-testid={`session-note-revisions-${note.id}`}>
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">{L.history}</p>
                  <ol className="space-y-1 text-xs text-gray-500">
                    {note.revisions.map((rev, index) => (
                      <li key={rev.id}>
                        <button
                          type="button"
                          className="text-left hover:text-blue-600"
                          onClick={() => setShownRevision(shownRevision === rev.id ? null : rev.id)}
                          aria-expanded={shownRevision === rev.id}
                        >
                          {index === 0 ? L.currentVersion : L.revisionLine.replace('{name}', rev.author?.fullName ?? L.someone)}
                          {' · '}
                          <RelativeTime date={rev.createdAt} />
                        </button>
                        {shownRevision === rev.id && (
                          <p className="mt-1 whitespace-pre-line rounded bg-gray-50 p-2 text-gray-700 dark:bg-gray-800 dark:text-gray-200">{rev.body}</p>
                        )}
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {!canWrite && loaded && readOnly && notes.length > 0 && (
        <p className="mt-3 text-xs text-gray-400">{L.archivedHint}</p>
      )}
      {error && <p className="mt-2 text-sm text-red-600" role="alert">{error}</p>}
    </Card>
  );
}
