'use client';

import { useCallback, useEffect, useState } from 'react';
import { Trash2, Lock } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { useT } from '@/i18n/client';
import { useToast } from '@/components/ui/Toast';

type Category = 'MEETING' | 'FEEDBACK' | 'TASKS' | 'PERSONAL';
const CATEGORIES: Category[] = ['MEETING', 'FEEDBACK', 'TASKS', 'PERSONAL'];

interface Note {
  id: string;
  body: string;
  category: Category;
  updatedAt: string;
}

// Private personal notes — visible only to the owner.
export function NotesPanel() {
  const t = useT();
  const toast = useToast();
  const [notes, setNotes] = useState<Note[]>([]);
  const [body, setBody] = useState('');
  const [category, setCategory] = useState<Category>('PERSONAL');
  const [categoryFilter, setCategoryFilter] = useState<'ALL' | Category>('ALL');
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
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body, category }),
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

  const shown = categoryFilter === 'ALL' ? notes : notes.filter((n) => n.category === categoryFilter);

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
                <Badge variant="default" className="text-[10px] mb-1">{t.portal.notes.categories[n.category]}</Badge>
                <p className="text-sm text-gray-700 whitespace-pre-wrap break-words">{n.body}</p>
              </div>
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
