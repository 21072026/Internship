'use client';

import { useCallback, useEffect, useState } from 'react';
import { Trash2, Lock, Pencil } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useT, useLocale } from '@/i18n/client';
import { relativeTime } from '@/lib/relativeTime';

interface Note {
  id: string;
  body: string;
  createdAt: string;
  author: { fullName: string };
}

// Mentor-private notes on a mentorship relation — impressions, prep notes,
// red flags. Visible only to the authoring mentor (and admins); the mentee
// never sees this panel or its data (EPIC: mentor private notes).
export function RelationNotesPanel({ relationId }: { relationId: string }) {
  const t = useT();
  const locale = useLocale();
  const c = t.relationNotes;
  const [notes, setNotes] = useState<Note[]>([]);
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState('');

  const load = useCallback(async () => {
    const res = await fetch(`/api/relation-notes?relationId=${relationId}`);
    if (res.ok) setNotes((await res.json()).notes ?? []);
  }, [relationId]);
  useEffect(() => { load(); }, [load]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!body.trim()) return;
    setSaving(true);
    try {
      const res = await fetch('/api/relation-notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relationId, body }),
      });
      if (res.ok) { setBody(''); await load(); }
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    await fetch(`/api/relation-notes/${id}`, { method: 'DELETE' });
    await load();
  };

  const startEdit = (n: Note) => { setEditingId(n.id); setEditBody(n.body); };
  const cancelEdit = () => { setEditingId(null); setEditBody(''); };
  const saveEdit = async (id: string) => {
    if (!editBody.trim()) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/relation-notes/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: editBody }),
      });
      if (res.ok) { cancelEdit(); await load(); }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card data-testid="relation-notes-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Lock className="h-4 w-4 text-gray-400" /> {c.title}
        </CardTitle>
      </CardHeader>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">{c.hint}</p>

      <form onSubmit={add} className="mb-4">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={c.placeholder}
          rows={3}
          className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm mb-2"
        />
        <Button type="submit" size="sm" loading={saving} disabled={!body.trim()}>{c.add}</Button>
      </form>

      {notes.length === 0 ? (
        <p className="text-sm text-gray-400 text-center py-4">{c.none}</p>
      ) : (
        <div className="space-y-3">
          {notes.map((n) => (
            <div key={n.id} className="rounded-lg border border-gray-100 dark:border-gray-800 p-3">
              {editingId === n.id ? (
                <div>
                  <textarea
                    value={editBody}
                    onChange={(e) => setEditBody(e.target.value)}
                    rows={3}
                    className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm mb-2"
                  />
                  <div className="flex gap-2">
                    <Button size="sm" loading={saving} disabled={!editBody.trim()} onClick={() => saveEdit(n.id)}>{t.common.save}</Button>
                    <Button size="sm" variant="outline" onClick={cancelEdit}>{t.common.cancel}</Button>
                  </div>
                </div>
              ) : (
                <>
                  <p className="text-sm text-gray-800 dark:text-gray-200 whitespace-pre-line">{n.body}</p>
                  <div className="flex items-center justify-between mt-2">
                    <p className="text-xs text-gray-400">
                      {n.author.fullName} · {relativeTime(n.createdAt, locale)}
                    </p>
                    <div className="flex items-center gap-2">
                      <button onClick={() => startEdit(n)} aria-label={t.common.edit} className="text-gray-300 hover:text-blue-600 dark:text-gray-600 dark:hover:text-blue-400">
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button onClick={() => remove(n.id)} aria-label={t.common.delete} className="text-gray-300 hover:text-red-600 dark:text-gray-600 dark:hover:text-red-400">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
