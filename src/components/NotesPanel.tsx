'use client';

import { useCallback, useEffect, useState } from 'react';
import { Trash2, Lock } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';
import { useToast } from '@/components/ui/Toast';

interface Note {
  id: string;
  body: string;
  updatedAt: string;
}

// Private personal notes — visible only to the owner.
export function NotesPanel() {
  const t = useT();
  const toast = useToast();
  const [notes, setNotes] = useState<Note[]>([]);
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);

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
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body }),
      });
      if (res.ok) { setBody(''); await load(); toast(t.portal.notes.added); }
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    await fetch(`/api/notes/${id}`, { method: 'DELETE' });
    await load();
    toast(t.portal.notes.deleted);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Lock className="h-4 w-4 text-gray-400" />{t.portal.notes.title}</CardTitle>
      </CardHeader>
      <p className="text-xs text-gray-400 mb-3">{t.portal.notes.privateHint}</p>

      <form onSubmit={add} className="space-y-2 mb-4">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={2}
          placeholder={t.portal.notes.placeholder}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400"
        />
        <Button type="submit" size="sm" loading={saving} disabled={!body.trim()}>{t.portal.notes.add}</Button>
      </form>

      {notes.length === 0 ? (
        <p className="text-sm text-gray-400">{t.portal.notes.none}</p>
      ) : (
        <div className="space-y-2">
          {notes.map((n) => (
            <div key={n.id} data-testid={`note-${n.id}`} className="group flex items-start justify-between gap-2 rounded-lg border border-gray-100 p-2.5">
              <p className="text-sm text-gray-700 whitespace-pre-wrap break-words flex-1">{n.body}</p>
              <button onClick={() => remove(n.id)} aria-label={t.common.delete} className="text-gray-300 hover:text-red-600 flex-shrink-0">
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
