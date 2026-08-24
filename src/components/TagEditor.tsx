'use client';

import { useCallback, useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useT } from '@/i18n/client';
import { MAX_TAGS_PER_USER, isValidTagName } from '@/lib/tags';
import type { TagOption } from '@/components/TagFilter';

/**
 * The labels on one person, editable in place (#887).
 *
 * Creating a label lives here rather than behind a settings screen because the
 * moment you want a new one is the moment you are looking at the person who
 * needs it. The vocabulary is still shared and still capped — this is a
 * shortcut into it, not a private list.
 */
export function TagEditor({ userId, initial }: { userId: string; initial: TagOption[] }) {
  const t = useT();
  const [mine, setMine] = useState<TagOption[]>(initial);
  const [vocabulary, setVocabulary] = useState<TagOption[]>([]);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const loadVocabulary = useCallback(() => {
    fetch('/api/tags')
      .then((r) => (r.ok ? r.json() : { tags: [] }))
      .then((d) => setVocabulary(d.tags ?? []))
      .catch(() => {});
  }, []);

  useEffect(loadVocabulary, [loadVocabulary]);

  const assign = async (tag: TagOption, action: 'add' | 'remove') => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/tags/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, tagId: tag.id, action }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.code === 'user_limit' ? t.tags.limitUser : data.code === 'not_your_mentee' ? t.tags.notYourMentee : data.error || '');
        return;
      }
      setMine((prev) => (action === 'add' ? [...prev.filter((x) => x.id !== tag.id), tag] : prev.filter((x) => x.id !== tag.id)));
    } finally {
      setBusy(false);
    }
  };

  const createAndAssign = async () => {
    if (!isValidTagName(newName)) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.tag) {
        setError(data.code === 'org_limit' ? t.tags.limitOrg : data.error || '');
        return;
      }
      setNewName('');
      loadVocabulary();
      await assign(data.tag as TagOption, 'add');
    } finally {
      setBusy(false);
    }
  };

  const atLimit = mine.length >= MAX_TAGS_PER_USER;
  const available = vocabulary.filter((tag) => !mine.some((m) => m.id === tag.id));

  return (
    <div data-testid="tag-editor">
      <p className="text-xs text-gray-500 mb-1">{t.tags.label}</p>
      <div className="flex flex-wrap gap-1">
        {mine.length === 0 && <span className="text-xs text-gray-400">{t.tags.none}</span>}
        {mine.map((tag) => (
          <span
            key={tag.id}
            data-testid={`tag-chip-${tag.id}`}
            className="inline-flex items-center gap-1 rounded-full bg-gray-100 dark:bg-gray-800 px-2 py-0.5 text-xs text-gray-700 dark:text-gray-200"
          >
            {tag.color && <span className="h-2 w-2 rounded-full" style={{ backgroundColor: tag.color }} aria-hidden />}
            {tag.name}
            <button
              type="button"
              disabled={busy}
              onClick={() => assign(tag, 'remove')}
              aria-label={`${t.tags.remove}: ${tag.name}`}
              className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-100"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select
          data-testid="tag-editor-select"
          aria-label={t.tags.add}
          value=""
          disabled={busy || atLimit || available.length === 0}
          onChange={(e) => {
            const tag = available.find((x) => x.id === e.target.value);
            if (tag) assign(tag, 'add');
          }}
          className="rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-xs text-gray-700 dark:text-gray-200"
        >
          <option value="">{t.tags.add}</option>
          {available.map((tag) => (
            <option key={tag.id} value={tag.id}>{tag.name}</option>
          ))}
        </select>
        <input
          type="text"
          data-testid="tag-editor-new"
          placeholder={t.tags.newTag}
          value={newName}
          disabled={busy || atLimit}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              createAndAssign();
            }
          }}
          className="w-40 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-xs"
        />
        <button
          type="button"
          data-testid="tag-editor-create"
          disabled={busy || atLimit || !isValidTagName(newName)}
          onClick={createAndAssign}
          className="rounded-lg border border-gray-300 dark:border-gray-700 px-2 py-1 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
        >
          {t.tags.create}
        </button>
      </div>
      {atLimit && <p className="mt-1 text-xs text-amber-600 dark:text-amber-300">{t.tags.limitUser}</p>}
      {error && <p data-testid="tag-editor-error" className="mt-1 text-xs text-red-600 dark:text-red-300">{error}</p>}
    </div>
  );
}
