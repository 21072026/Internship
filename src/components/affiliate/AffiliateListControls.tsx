'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { useT } from '@/i18n/client';
import { resultCountMessage, useFilterAnnouncement } from '@/hooks/useFilterAnnouncement';
import { defaultListQuery, hasListFilter, listQueryParams, parseListQuery, LIST_SEARCH_MAX, type ListQuery, type ListQueryField, type ListSpec, type SortDir } from '@/lib/affiliateListQueryRule';

// The filter bar and the sortable column header of the admin's affiliate lists
// (docs/affiliate-module.md § Admin screens, #3539). The URL is the state: the
// screen reads its query with the routes' own parser and writes every change
// back to the URL, so a link (and the overview's shortcuts) open the same view.
// Filtering and sorting happen on the server; nothing here narrows a page of rows.

const FIELD_PARAM: Record<ListQueryField, string> = {
  partnerId: 'partnerId',
  q: 'q',
  from: 'from',
  to: 'to',
  range: 'to',
  status: 'status',
  kind: 'kind',
  sort: 'sort',
  dir: 'dir',
};

/**
 * The list's query from the URL. A value the server would refuse (a hand-edited
 * link, an end day before the start) is dropped — only that one — so the rest of
 * the view survives and the request never answers 400.
 */
export function useAffiliateListQuery(spec: ListSpec) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const query = useMemo(() => {
    const params = new URLSearchParams(search);
    for (let i = 0; i < 10; i += 1) {
      const parsed = parseListQuery(spec, params);
      if (parsed.ok) return parsed.query;
      params.delete(FIELD_PARAM[parsed.field]);
    }
    return defaultListQuery(spec);
  }, [spec, search]);

  /** Any change but the page's own goes back to page 1. */
  const set = useCallback(
    (patch: Partial<ListQuery>) => {
      const qs = listQueryParams(spec, { ...query, page: 1, ...patch }).toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [spec, query, router, pathname],
  );
  return { query, set };
}

export interface ListOption {
  value: string;
  label: string;
}

/**
 * The filters a list offers, from its spec: partner, search, date range, status,
 * kind — and, for a list that is not a table (partners), a sort select. Each
 * field writes to the URL at once; the search waits until typing pauses.
 */
export function AffiliateListToolbar({
  spec,
  query,
  set,
  partners,
  searchLabel,
  dateLabel,
  statusOptions,
  kindOptions,
  sortOptions,
  allStatusesLabel,
  resultCount,
}: {
  spec: ListSpec;
  query: ListQuery;
  set: (patch: Partial<ListQuery>) => void;
  partners?: { id: string; code: string; displayName: string }[];
  searchLabel?: string;
  /** What the date range is over (due, received, paid). */
  dateLabel?: string;
  statusOptions?: ListOption[];
  kindOptions?: ListOption[];
  sortOptions?: ListOption[];
  /** The "any status" choice; omitted when the screen always shows one status. */
  allStatusesLabel?: string;
  /** How many rows the filtered list holds (all pages); null while it loads. */
  resultCount: number | null;
}) {
  const t = useT();
  const L = t.affiliateList;
  const [term, setTerm] = useState(query.q ?? '');
  // The list is rewritten in place, focus stays here: say how many rows match (WCAG 4.1.3).
  useFilterAnnouncement(hasListFilter(query) && resultCount !== null ? resultCountMessage(t.a11y, resultCount) : null);

  // The URL moved on its own (back button, "clear"): the box follows it.
  useEffect(() => setTerm(query.q ?? ''), [query.q]);
  useEffect(() => {
    const next = term.trim() === '' ? null : term.trim();
    if (next === query.q) return;
    const timer = setTimeout(() => set({ q: next }), 300);
    return () => clearTimeout(timer);
  }, [term, query.q, set]);

  return (
    <div className="flex flex-wrap items-end gap-3" role="search" aria-label={L.filters} data-testid="affiliate-list-toolbar">
      {spec.partner && partners && (
        <div className="w-full sm:w-56">
          <Select
            id="affiliate-filter-partner"
            label={L.partner}
            value={query.partnerId ?? ''}
            onChange={(e) => set({ partnerId: e.target.value || null })}
            options={[{ value: '', label: L.allPartners }, ...partners.map((p) => ({ value: p.id, label: `${p.displayName} (${p.code})` }))]}
            data-testid="affiliate-filter-partner"
          />
        </div>
      )}
      {spec.search && (
        <div className="w-full sm:w-56">
          <Input
            id="affiliate-filter-q"
            type="search"
            label={searchLabel ?? L.search}
            maxLength={LIST_SEARCH_MAX}
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            data-testid="affiliate-filter-q"
          />
        </div>
      )}
      {spec.dateRange && (
        <>
          <div className="w-full sm:w-44">
            <Input
              id="affiliate-filter-from"
              type="date"
              label={dateLabel ? `${dateLabel} · ${L.from}` : L.from}
              value={query.from ?? ''}
              max={query.to ?? undefined}
              onChange={(e) => set({ from: e.target.value || null })}
              data-testid="affiliate-filter-from"
            />
          </div>
          <div className="w-full sm:w-44">
            <Input
              id="affiliate-filter-to"
              type="date"
              label={dateLabel ? `${dateLabel} · ${L.to}` : L.to}
              value={query.to ?? ''}
              min={query.from ?? undefined}
              onChange={(e) => set({ to: e.target.value || null })}
              data-testid="affiliate-filter-to"
            />
          </div>
        </>
      )}
      {statusOptions && allStatusesLabel && (
        <div className="w-full sm:w-44">
          <Select
            id="affiliate-filter-status"
            label={L.status}
            value={query.status ?? ''}
            onChange={(e) => set({ status: e.target.value || null })}
            options={[{ value: '', label: allStatusesLabel }, ...statusOptions]}
            data-testid="affiliate-filter-status"
          />
        </div>
      )}
      {kindOptions && (
        <div className="w-full sm:w-44">
          <Select
            id="affiliate-filter-kind"
            label={L.kind}
            value={query.kind ?? ''}
            onChange={(e) => set({ kind: e.target.value || null })}
            options={[{ value: '', label: L.allKinds }, ...kindOptions]}
            data-testid="affiliate-filter-kind"
          />
        </div>
      )}
      {sortOptions && (
        <>
          <div className="w-full sm:w-48">
            <Select
              id="affiliate-sort"
              label={L.sortBy}
              value={query.sort}
              onChange={(e) => set({ sort: e.target.value })}
              options={sortOptions}
              data-testid="affiliate-sort"
            />
          </div>
          <div className="w-full sm:w-40">
            <Select
              id="affiliate-sort-dir"
              label={L.direction}
              value={query.dir}
              onChange={(e) => set({ dir: e.target.value as SortDir })}
              options={[
                { value: 'asc', label: L.asc },
                { value: 'desc', label: L.desc },
              ]}
              data-testid="affiliate-sort-dir"
            />
          </div>
        </>
      )}
      {hasListFilter(query) && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => set({ partnerId: null, q: null, from: null, to: null, status: null, kind: null })}
          data-testid="affiliate-filter-clear"
        >
          {L.clear}
        </Button>
      )}
    </div>
  );
}

/**
 * A column header that sorts the list on the server. The first click on a new
 * column uses `firstDir` (newest / largest first for dates and amounts); a click
 * on the active column flips the direction.
 */
export function SortHeader({
  label,
  sortKey,
  query,
  set,
  firstDir = 'desc',
  numeric = false,
}: {
  label: string;
  sortKey: string;
  query: ListQuery;
  set: (patch: Partial<ListQuery>) => void;
  firstDir?: SortDir;
  numeric?: boolean;
}) {
  const active = query.sort === sortKey;
  return (
    <th className={`px-4 py-2 ${numeric ? 'text-right' : ''}`} aria-sort={active ? (query.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button
        type="button"
        onClick={() => set({ sort: sortKey, dir: active ? (query.dir === 'asc' ? 'desc' : 'asc') : firstDir })}
        className="inline-flex items-center gap-1 hover:text-gray-900 dark:hover:text-gray-100"
        data-testid={`affiliate-sort-${sortKey}`}
      >
        {label}
        {active && (query.dir === 'asc' ? <ArrowUp className="h-3 w-3" aria-hidden /> : <ArrowDown className="h-3 w-3" aria-hidden />)}
      </button>
    </th>
  );
}
