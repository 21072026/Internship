'use client';

import { useT } from '@/i18n/client';

export interface TagOption {
  id: string;
  name: string;
  color?: string | null;
  usageCount?: number;
}

/**
 * The tag filter on a list page (#887).
 *
 * Toggle chips rather than a multi-select, because the question being asked is
 * "which of our labels am I looking for" and the answer is visible at a glance
 * — a closed <select multiple> hides both the vocabulary and the current
 * choice. The any/all switch is deliberately explicit: "React AND available"
 * and "React OR available" are very different lists and guessing wrong quietly
 * gives the wrong answer.
 */
export function TagFilter({
  tags,
  selected,
  mode,
  onToggle,
  onModeChange,
}: {
  tags: TagOption[];
  selected: string[];
  mode: 'and' | 'or';
  onToggle: (id: string) => void;
  onModeChange: (mode: 'and' | 'or') => void;
}) {
  const t = useT();
  if (tags.length === 0) return null;

  return (
    <div data-testid="tag-filter" className="mt-3 border-t border-gray-100 dark:border-gray-800 pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-gray-500 dark:text-gray-400">{t.tags.filter}</span>
        {tags.map((tag) => {
          const active = selected.includes(tag.id);
          return (
            <button
              key={tag.id}
              type="button"
              aria-pressed={active}
              data-testid={`tag-filter-chip-${tag.id}`}
              onClick={() => onToggle(tag.id)}
              className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors ${
                active
                  ? 'border-blue-500 bg-blue-600 text-white'
                  : 'border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800'
              }`}
            >
              {tag.color && !active && (
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: tag.color }} aria-hidden />
              )}
              {tag.name}
            </button>
          );
        })}
        {selected.length > 1 && (
          <select
            data-testid="tag-filter-mode"
            aria-label={t.tags.filter}
            value={mode}
            onChange={(e) => onModeChange(e.target.value === 'and' ? 'and' : 'or')}
            className="rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-xs text-gray-600 dark:text-gray-300"
          >
            <option value="or">{t.tags.modeAny}</option>
            <option value="and">{t.tags.modeAll}</option>
          </select>
        )}
      </div>
      {/* Cohort, source and tag are three different things and people conflate
          them within a week of shipping — say the boundary where it is used. */}
      <p className="mt-2 text-xs text-gray-400 dark:text-gray-500">{t.tags.vsCohort}</p>
    </div>
  );
}

/** The labels a person carries, shown on their row. */
export function TagChips({ tags, testId }: { tags: TagOption[]; testId?: string }) {
  if (tags.length === 0) return null;
  return (
    <div data-testid={testId} className="flex flex-wrap gap-1">
      {tags.map((tag) => (
        <span
          key={tag.id}
          className="inline-flex items-center gap-1 rounded-full bg-gray-100 dark:bg-gray-800 px-2 py-0.5 text-xs text-gray-700 dark:text-gray-200"
        >
          {tag.color && <span className="h-2 w-2 rounded-full" style={{ backgroundColor: tag.color }} aria-hidden />}
          {tag.name}
        </span>
      ))}
    </div>
  );
}
