'use client';

import { useCallback, useEffect, useState } from 'react';
import { Bookmark, Users, X } from 'lucide-react';
import { useT } from '@/i18n/client';
import type { SavedViewDto, SavedViewSurface } from '@/lib/savedViews';

type Filters = Record<string, string>;
interface LocalView { name: string; filters: Filters }

// Named filter presets for a list page.
//
// With a `surface` (#1900) the views live on the server: they follow the admin
// to another device, and one can be shared with every admin of the org. The
// first time a surface has no server views but this browser still holds
// localStorage presets under `storageKey`, they are moved up once (as private
// views) and the key is cleared — nobody loses the presets they had.
//
// Without a `surface` (the mentor's own list) it stays the localStorage preset
// it always was; the server API is admin-only.
export function SavedViews({
  storageKey,
  surface,
  current,
  onApply,
}: {
  storageKey: string;
  surface?: SavedViewSurface;
  current: Filters;
  onApply: (f: Filters) => void;
}) {
  const t = useT();
  const s = t.savedViews;
  const [views, setViews] = useState<SavedViewDto[]>([]);
  const [dialog, setDialog] = useState(false);
  const [name, setName] = useState('');
  const [share, setShare] = useState(false);
  const [error, setError] = useState('');

  const readLocal = useCallback((): LocalView[] => {
    try {
      const parsed = JSON.parse(localStorage.getItem(storageKey) || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }, [storageKey]);

  const load = useCallback(async () => {
    if (!surface) {
      setViews(readLocal().map((v) => ({ id: v.name, name: v.name, filters: v.filters, visibility: 'PRIVATE', mine: true, author: null })));
      return;
    }
    const res = await fetch(`/api/admin/saved-views?surface=${surface}`).catch(() => null);
    if (!res?.ok) return;
    let list: SavedViewDto[] = (await res.json()).views ?? [];
    // One-time move of this browser's old presets (#1900).
    const local = readLocal();
    if (local.length > 0 && !list.some((v) => v.mine)) {
      for (const v of local) {
        await fetch('/api/admin/saved-views', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ surface, name: v.name, filters: v.filters, visibility: 'PRIVATE' }),
        }).catch(() => null);
      }
      try {
        localStorage.removeItem(storageKey);
      } catch {
        /* storage unavailable — the server copy is what counts now */
      }
      const again = await fetch(`/api/admin/saved-views?surface=${surface}`).catch(() => null);
      if (again?.ok) list = (await again.json()).views ?? [];
    }
    setViews(list);
  }, [surface, storageKey, readLocal]);

  useEffect(() => {
    load();
  }, [load]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setError('');
    if (!surface) {
      const next = [...readLocal().filter((v) => v.name !== trimmed), { name: trimmed, filters: current }];
      localStorage.setItem(storageKey, JSON.stringify(next));
    } else {
      const res = await fetch('/api/admin/saved-views', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ surface, name: trimmed, filters: current, visibility: share ? 'ORG' : 'PRIVATE' }),
      }).catch(() => null);
      if (!res?.ok) {
        setError(s.failed);
        return;
      }
    }
    setDialog(false);
    setName('');
    setShare(false);
    await load();
  };

  const remove = async (view: SavedViewDto) => {
    if (!surface) {
      localStorage.setItem(storageKey, JSON.stringify(readLocal().filter((v) => v.name !== view.name)));
    } else {
      await fetch(`/api/admin/saved-views/${view.id}`, { method: 'DELETE' }).catch(() => null);
    }
    await load();
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => setDialog((open) => !open)}
        data-testid="saved-views-save"
        aria-expanded={dialog}
        className="inline-flex min-h-[36px] items-center gap-1 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300"
      >
        <Bookmark className="h-4 w-4" />
        {s.save}
      </button>
      {views.map((v) => (
        <span
          key={v.id}
          data-testid={`saved-view-chip-${v.id}`}
          className="inline-flex items-center gap-1 rounded-lg bg-blue-50 px-2.5 py-1.5 text-sm text-blue-700"
          title={v.visibility === 'ORG' ? (v.mine ? s.shared : s.sharedBy.replace('{name}', v.author ?? '')) : undefined}
        >
          {v.visibility === 'ORG' && <Users className="h-3.5 w-3.5" aria-label={s.shared} />}
          <button type="button" onClick={() => onApply(v.filters)} className="font-medium hover:underline">{v.name}</button>
          {v.mine && (
            <button type="button" onClick={() => remove(v)} aria-label={s.remove} className="text-blue-400 hover:text-blue-700" data-testid={`saved-view-remove-${v.id}`}>
              <X className="h-3 w-3" />
            </button>
          )}
        </span>
      ))}
      {dialog && (
        <form onSubmit={save} className="flex w-full flex-wrap items-center gap-2 rounded-lg border border-gray-200 p-2 dark:border-gray-700" data-testid="saved-views-dialog">
          <label className="sr-only" htmlFor={`saved-view-name-${storageKey}`}>{s.namePrompt}</label>
          <input
            id={`saved-view-name-${storageKey}`}
            autoFocus
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            placeholder={s.namePrompt}
            data-testid="saved-views-name"
            className="min-h-[36px] flex-1 rounded-lg border border-gray-300 px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-800"
          />
          {surface && (
            <label className="flex items-center gap-1 text-sm text-gray-700 dark:text-gray-300">
              <input type="checkbox" checked={share} onChange={(e) => setShare(e.target.checked)} data-testid="saved-views-share" />
              {s.share}
            </label>
          )}
          <button type="submit" className="min-h-[36px] rounded-lg bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700" data-testid="saved-views-confirm">{s.confirm}</button>
          <button type="button" onClick={() => setDialog(false)} className="min-h-[36px] rounded-lg px-3 py-1 text-sm text-gray-600 hover:bg-gray-50 dark:text-gray-300">{t.common.cancel}</button>
          {error && <p className="w-full text-sm text-red-600" role="alert">{error}</p>}
        </form>
      )}
    </div>
  );
}
