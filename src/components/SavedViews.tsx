'use client';

import { useEffect, useState } from 'react';
import { Bookmark, X } from 'lucide-react';
import { useT } from '@/i18n/client';

type Filters = Record<string, string>;
interface View { name: string; filters: Filters }

// Named, client-stored filter presets for a list page (kept in localStorage).
export function SavedViews({
  storageKey,
  current,
  onApply,
}: {
  storageKey: string;
  current: Filters;
  onApply: (f: Filters) => void;
}) {
  const t = useT();
  const [views, setViews] = useState<View[]>([]);

  useEffect(() => {
    try {
      setViews(JSON.parse(localStorage.getItem(storageKey) || '[]'));
    } catch {
      setViews([]);
    }
  }, [storageKey]);

  const persist = (next: View[]) => {
    setViews(next);
    localStorage.setItem(storageKey, JSON.stringify(next));
  };

  const save = () => {
    const name = window.prompt(t.savedViews.namePrompt);
    if (!name) return;
    persist([...views.filter((v) => v.name !== name), { name, filters: current }]);
  };

  const remove = (name: string) => persist(views.filter((v) => v.name !== name));

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        onClick={save}
        data-testid="saved-views-save"
        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-gray-200 bg-white text-sm text-gray-600 hover:bg-gray-50"
      >
        <Bookmark className="h-4 w-4" />
        {t.savedViews.save}
      </button>
      {views.map((v) => (
        <span key={v.name} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-blue-50 text-blue-700 text-sm">
          <button onClick={() => onApply(v.filters)} className="font-medium hover:underline">{v.name}</button>
          <button onClick={() => remove(v.name)} aria-label="remove" className="text-blue-400 hover:text-blue-700">
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
    </div>
  );
}
