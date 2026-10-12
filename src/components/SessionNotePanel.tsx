'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, Circle, History, ListTodo, NotebookPen, Pencil, Plus, X } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Textarea } from '@/components/ui/Textarea';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { useT, useLocale } from '@/i18n/client';
import { useRealtime } from '@/hooks/useRealtime';
import { formatDate } from '@/lib/relativeTime';
import { TEXT_LIMITS } from '@/lib/textLimits';
import { normalizeActionText, parseActionItems, setActionItemDone } from '@/lib/minutesActionItems';

// The pair's shared minutes (#1847): what was said and agreed in a session,
// written by either seat and readable by both — the third note model beside
// the two private ones, which this panel never touches. Authorization lives in
// /api/session-notes; `readOnly` and the server's `writable` flag only hide the
// editor (an admin reads, an archived mentorship is read-only for the mentee).
// Every save writes a revision naming the editor; the trail is shown as a list,
// not a diff. Both seats see the same text without polling: writes publish a
// `sessionNote` realtime signal for the relation and the panel refetches.
//
// #1849: minutes can be pinned to one of the pairing's past meetings (they
// then become that meeting's interaction log), and every `- [ ]` line is an
// action item: tick it here, or promote it to a to-do on the mentor's or the
// mentee's list — the two stay in step either way.

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

interface ActionItemLink {
  taskId: string;
  text: string;
  done: boolean;
  assignee: Person | null;
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
  actionItems: ActionItemLink[];
}

interface MeetingOption {
  id: string;
  title: string;
  scheduledAt: string | null;
  hasMinutes: boolean;
}

export function SessionNotePanel({ relationId, readOnly = false }: { relationId: string; readOnly?: boolean }) {
  const t = useT();
  const locale = useLocale();
  const L = t.sessionNotes;
  const [notes, setNotes] = useState<Note[]>([]);
  const [writable, setWritable] = useState(false);
  const [participants, setParticipants] = useState<Person[]>([]);
  const [meetings, setMeetings] = useState<MeetingOption[]>([]);
  const [draftMeeting, setDraftMeeting] = useState('');
  const [promoteFor, setPromoteFor] = useState<Record<string, string>>({});
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
      setParticipants(body.participants ?? []);
      setMeetings(body.meetings ?? []);
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
      body: JSON.stringify({ relationId, body: draft.trim(), meetingId: draftMeeting || undefined }),
    });
    if (body) {
      setDraft('');
      setDraftMeeting('');
      setComposing(false);
    }
  };

  // Tick a `- [ ]` line in place: the body is saved with the checkbox flipped;
  // the server ticks the to-do it was promoted to, if any.
  const toggleLine = async (note: Note, text: string, done: boolean) => {
    const next = setActionItemDone(note.body, text, done);
    if (next === note.body) return;
    await call(`${note.id}:${text}`, `/api/session-notes/${note.id}`, { method: 'PATCH', body: JSON.stringify({ body: next }) });
  };

  const promote = async (note: Note, text: string) => {
    const assigneeId = promoteFor[`${note.id}:${text}`] || participants[0]?.id;
    if (!assigneeId) return;
    await call(`promote:${note.id}:${text}`, `/api/session-notes/${note.id}/action-items`, {
      method: 'POST',
      body: JSON.stringify({ text, assigneeId }),
    });
  };

  const linkFor = (note: Note, text: string) => {
    const wanted = normalizeActionText(text);
    return note.actionItems.find((a) => normalizeActionText(a.text) === wanted) ?? null;
  };

  const meetingLabel = (m: { title: string; scheduledAt: string | null }) =>
    m.scheduledAt ? `${m.title} · ${formatDate(m.scheduledAt, locale)}` : m.title;

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
          {meetings.length > 0 && (
            <Select
              label={L.forMeeting}
              value={draftMeeting}
              onChange={(e) => setDraftMeeting(e.target.value)}
              options={[
                { value: '', label: L.noMeeting },
                ...meetings.map((m) => ({ value: m.id, label: m.hasMinutes ? `${meetingLabel(m)} · ${L.hasMinutes}` : meetingLabel(m) })),
              ]}
              data-testid="session-note-meeting"
            />
          )}
          <p className="text-xs text-gray-400">{L.actionItemHint}</p>
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
                {note.meeting && <span className="font-medium text-gray-700" data-testid="session-note-meeting-label">{meetingLabel(note.meeting)}</span>}
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

              {editingId !== note.id && parseActionItems(note.body).length > 0 && (
                <ul className="mt-3 space-y-1.5 border-t border-gray-100 pt-2 dark:border-gray-800" data-testid={`session-note-actions-${note.id}`}>
                  {parseActionItems(note.body).map((item) => {
                    const link = linkFor(note, item.text);
                    const key = `${note.id}:${item.text}`;
                    return (
                      <li key={item.line} className="flex flex-wrap items-center gap-2 text-sm" data-testid={`session-note-action-${note.id}-${item.line}`}>
                        <button
                          type="button"
                          onClick={() => canWrite && toggleLine(note, item.text, !item.done)}
                          disabled={!canWrite || busy === key}
                          aria-label={item.done ? L.markOpen : L.markDone}
                          aria-pressed={item.done}
                          data-testid={`session-note-action-toggle-${note.id}-${item.line}`}
                          className={`${item.done ? 'text-green-600' : 'text-gray-300 hover:text-gray-500'} disabled:cursor-default`}
                        >
                          {item.done ? <Check className="h-4 w-4" /> : <Circle className="h-4 w-4" />}
                        </button>
                        <span className={item.done ? 'text-gray-400 line-through' : 'text-gray-800'}>{item.text}</span>
                        {link ? (
                          <span
                            className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-[11px] text-blue-700"
                            data-testid={`session-note-action-link-${note.id}-${item.line}`}
                          >
                            <ListTodo className="h-3 w-3" aria-hidden="true" />
                            {L.promotedFor.replace('{name}', link.assignee?.fullName ?? L.someone)}
                          </span>
                        ) : (
                          canWrite &&
                          participants.length > 0 && (
                            <span className="ml-auto flex items-center gap-1">
                              <Select
                                aria-label={L.promoteFor}
                                value={promoteFor[key] ?? participants[0].id}
                                onChange={(e) => setPromoteFor((prev) => ({ ...prev, [key]: e.target.value }))}
                                className="py-1 pl-2 pr-7 text-xs"
                                options={participants.map((p) => ({ value: p.id, label: p.fullName }))}
                                data-testid={`session-note-action-assignee-${note.id}-${item.line}`}
                              />
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                loading={busy === `promote:${key}`}
                                onClick={() => promote(note, item.text)}
                                data-testid={`session-note-action-promote-${note.id}-${item.line}`}
                              >
                                <ListTodo className="h-3.5 w-3.5" />
                                {L.promote}
                              </Button>
                            </span>
                          )
                        )}
                      </li>
                    );
                  })}
                </ul>
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
