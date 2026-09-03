'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search } from 'lucide-react';
import { useT } from '@/i18n/client';

interface UserHit { id: string; fullName: string; email: string; role: string; relationId?: string | null }
interface CompanyHit { id: string; name: string }

interface Option {
  /** Stable key — also the DOM id (aria-activedescendant) and the testid suffix. */
  key: string;
  href: string;
}

const LISTBOX_ID = 'global-search-listbox';
const optionDomId = (key: string) => `global-search-option-${key}`;

const userHref = (u: UserHit) =>
  u.relationId ? `/mentor/mentees/${u.relationId}` : u.role === 'MENTEE' ? `/admin/candidates/${u.id}` : `/admin/users`;

export function GlobalSearch() {
  const t = useT();
  const router = useRouter();
  const [q, setQ] = useState('');
  const [users, setUsers] = useState<UserHit[]>([]);
  const [companies, setCompanies] = useState<CompanyHit[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  // True once a query has actually come back, so the "no results" row only
  // appears after the debounce settles — not while the user is still typing.
  const [searched, setSearched] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (q.trim().length < 2) {
      setUsers([]); setCompanies([]); setSearched(false); setLoading(false); setActiveIndex(-1);
      return;
    }
    setLoading(true);
    const id = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        const d = await res.json();
        setUsers(d.users ?? []);
        setCompanies(d.companies ?? []);
        setOpen(true);
      } catch {
        setUsers([]); setCompanies([]);
      } finally {
        setLoading(false);
        setSearched(true);
        setActiveIndex(-1);
      }
    }, 250);
    return () => clearTimeout(id);
  }, [q]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  // One flat list drives both the rendering and the keyboard cursor, so the
  // active index can never drift out of step with what is on screen.
  const options = useMemo<Option[]>(() => [
    ...users.map((u) => ({ key: `user-${u.id}`, href: userHref(u) })),
    ...companies.map((c) => ({ key: `company-${c.id}`, href: '/admin/companies' })),
  ], [users, companies]);

  const panelOpen = open && q.trim().length >= 2 && (options.length > 0 || searched || loading);

  const go = useCallback((href: string) => {
    setOpen(false);
    setQ('');
    setActiveIndex(-1);
    router.push(href);
  }, [router]);

  // Keep the highlighted option visible inside the max-h-96 scroll area.
  useEffect(() => {
    const key = activeIndex >= 0 ? options[activeIndex]?.key : undefined;
    if (!key || !listRef.current) return;
    document.getElementById(optionDomId(key))?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, options]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      // Close without navigating; focus stays on (or returns to) the input.
      e.preventDefault();
      setOpen(false);
      setActiveIndex(-1);
      inputRef.current?.focus();
      return;
    }
    if (e.key === 'Tab') {
      setOpen(false);
      setActiveIndex(-1);
      return;
    }
    if (e.key === 'Enter') {
      if (panelOpen && activeIndex >= 0 && options[activeIndex]) {
        e.preventDefault();
        go(options[activeIndex].href);
      }
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    if (options.length === 0) return;
    e.preventDefault();
    if (!open) setOpen(true);
    setActiveIndex((i) => {
      if (e.key === 'Home') return 0;
      if (e.key === 'End') return options.length - 1;
      if (e.key === 'ArrowDown') return i >= options.length - 1 ? 0 : i + 1;
      return i <= 0 ? options.length - 1 : i - 1;
    });
  };

  const activeKey = activeIndex >= 0 ? options[activeIndex]?.key : undefined;

  const optionClass = (index: number) =>
    // `bg-white` / `bg-gray-50` / `text-gray-*` carry no `dark:` variants on
    // purpose: globals.css's flat `html.dark .bg-white` (specificity 0,2,1)
    // outranks Tailwind's `.dark .dark\:bg-*` (0,2,0), so a variant here would
    // be dead code. The flat rules already render the panel #111827 with
    // #f3f4f6 / #9ca3af text and a #1f2937 active row — all AA on that ground.
    `block w-full text-left px-4 py-2.5 text-sm hover:bg-gray-50 ${
      index === activeIndex ? 'bg-gray-50 ring-2 ring-inset ring-blue-500' : ''
    }`;

  return (
    <div className="relative w-56" ref={ref}>
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-gray-200 bg-white focus-within:ring-2 focus-within:ring-blue-500">
        <Search className="h-4 w-4 text-gray-500" aria-hidden="true" />
        <input
          ref={inputRef}
          data-testid="global-search-input"
          role="combobox"
          aria-expanded={panelOpen}
          aria-controls={panelOpen && options.length > 0 ? LISTBOX_ID : undefined}
          aria-activedescendant={activeKey ? optionDomId(activeKey) : undefined}
          aria-autocomplete="list"
          aria-label={t.search.placeholder}
          autoComplete="off"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => q.trim().length >= 2 && setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={t.search.placeholder}
          className="flex-1 text-sm outline-none bg-transparent"
        />
      </div>
      {panelOpen && (
        <div
          ref={listRef}
          data-testid="global-search-panel"
          className="absolute right-0 mt-2 w-72 max-h-96 overflow-y-auto rounded-xl border border-gray-200 bg-white shadow-lg z-50"
        >
          {options.length > 0 ? (
            <div
              id={LISTBOX_ID}
              role="listbox"
              aria-label={t.search.placeholder}
              data-testid="global-search-listbox"
            >
              {users.map((u, i) => (
                <div
                  key={u.id}
                  id={optionDomId(`user-${u.id}`)}
                  data-testid={`global-search-option-user-${u.id}`}
                  role="option"
                  aria-selected={activeIndex === i}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => go(userHref(u))}
                  className={optionClass(i)}
                >
                  <span className="font-medium text-gray-900">{u.fullName}</span>
                  <span className="text-xs text-gray-500 ml-2">{u.role}</span>
                  <span className="block text-xs text-gray-500 truncate">{u.email}</span>
                </div>
              ))}
              {companies.map((c, ci) => (
                <div
                  key={c.id}
                  id={optionDomId(`company-${c.id}`)}
                  data-testid={`global-search-option-company-${c.id}`}
                  role="option"
                  aria-selected={activeIndex === users.length + ci}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => go('/admin/companies')}
                  className={optionClass(users.length + ci)}
                >
                  <span className="font-medium text-gray-900">{c.name}</span>
                  <span className="text-xs text-gray-500 ml-2">{t.search.company}</span>
                </div>
              ))}
            </div>
          ) : (
            <p data-testid="global-search-empty" className="px-4 py-3 text-sm text-gray-500">
              {loading ? t.search.searching : t.search.noResults}
            </p>
          )}
        </div>
      )}
      {/* Status for assistive tech: the result count, announced once the
          debounced request has settled. */}
      <p role="status" aria-live="polite" className="sr-only" data-testid="global-search-status">
        {searched && !loading && q.trim().length >= 2
          ? (options.length === 0 ? t.search.noResults : t.search.resultCount.replace('{count}', String(options.length)))
          : ''}
      </p>
    </div>
  );
}
