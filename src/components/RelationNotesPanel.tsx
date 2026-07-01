'use client';

import { useCallback, useEffect, useState } from 'react';
import { Trash2, Lock } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';

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
  const c = t.relationNotes;
  const [notes, setNotes] = useState<Note[]>([]);
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);

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
              <p className="text-sm text-gray-800 dark:text-gray-200 whitespace-pre-line">{n.body}</p>
              <div className="flex items-center justify-between mt-2">
                <p className="text-xs text-gray-400">
                  {n.author.fullName} · {new Date(n.createdAt).toLocaleDateString()}
                </p>
                <button onClick={() => remove(n.id)} aria-label={t.common.delete} className="text-gray-300 hover:text-red-600 dark:text-gray-600 dark:hover:text-red-400">
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
