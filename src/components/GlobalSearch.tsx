'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search } from 'lucide-react';
import { useT } from '@/i18n/client';

interface UserHit { id: string; fullName: string; email: string; role: string; relationId?: string | null }
interface CompanyHit { id: string; name: string }

type SearchOption =
  | { kind: 'user'; id: string; href: string; hit: UserHit }
  | { kind: 'company'; id: string; href: string; hit: CompanyHit };

// Only one GlobalSearch is mounted per page (ResponsiveShell renders it once, in
// the desktop top strip), so plain constant ids are safe and keep the DOM ids
// aligned with the data-testids the e2e specs use.
const LISTBOX_ID = 'global-search-listbox';
const EMPTY_OPTION_ID = 'global-search-no-results';
const optionDomId = (id: string) => `global-search-option-${id}`;

const userHref = (u: UserHit) =>
  u.relationId ? `/mentor/mentees/${u.relationId}` : u.role === 'MENTEE' ? `/admin/candidates/${u.id}` : `/admin/users`;

export function GlobalSearch() {
  const t = useT();
  const router = useRouter();
  const [q, setQ] = useState('');
  const [users, setUsers] = useState<UserHit[]>([]);
  const [companies, setCompanies] = useState<CompanyHit[]>([]);
  const [open, setOpen] = useState(false);
  // Index into `options` of the keyboard-highlighted row; -1 = none, which is
  // the correct initial state for a combobox (the input keeps DOM focus and
  // aria-activedescendant is simply absent).
  const [activeIndex, setActiveIndex] = useState(-1);
  const [liveMessage, setLiveMessage] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const options = useMemo<SearchOption[]>(
    () => [
      ...users.map((u): SearchOption => ({ kind: 'user', id: u.id, href: userHref(u), hit: u })),
      ...companies.map((c): SearchOption => ({ kind: 'company', id: c.id, href: '/admin/companies', hit: c })),
    ],
    [users, companies],
  );

  const queryIsSearchable = q.trim().length >= 2;
  // The panel renders even with zero hits: a query that matched nothing used to
  // render nothing at all, which looks like a broken search box.
  const showPanel = open && queryIsSearchable;

  useEffect(() => {
    if (!queryIsSearchable) {
      setUsers([]); setCompanies([]); setActiveIndex(-1); setLiveMessage(''); setOpen(false);
      return;
    }
    const id = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        const d = await res.json();
        const nextUsers: UserHit[] = d.users ?? [];
        const nextCompanies: CompanyHit[] = d.companies ?? [];
        setUsers(nextUsers);
        setCompanies(nextCompanies);
        setActiveIndex(-1);
        setOpen(true);
        // Announced only once the debounce has settled and the response is in,
        // so assistive tech hears one result count per search instead of one
        // per keystroke.
        const count = nextUsers.length + nextCompanies.length;
        setLiveMessage(
          count === 0 ? t.search.noResults : t.search.resultsCount.replace('{count}', String(count)),
        );
      } catch {
        /* ignore */
      }
    }, 250);
    return () => clearTimeout(id);
  }, [q, queryIsSearchable, t]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setActiveIndex(-1);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  // Keep the highlighted row visible inside the max-h-96 scroll container.
  useEffect(() => {
    if (!showPanel || activeIndex < 0) return;
    const active = options[activeIndex];
    if (!active) return;
    document.getElementById(optionDomId(active.id))?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, options, showPanel]);

  const close = useCallback(() => {
    setOpen(false);
    setActiveIndex(-1);
  }, []);

  const go = useCallback((href: string) => {
    setOpen(false);
    setActiveIndex(-1);
    setLiveMessage('');
    setQ('');
    router.push(href);
  }, [router]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      // Only swallow Escape when there is a panel to close, so the key stays
      // available to whatever else may be listening for it.
      if (showPanel) {
        e.preventDefault();
        close();
        inputRef.current?.focus();
      }
      return;
    }
    if (e.key === 'Tab') {
      // Tab leaves the widget without picking a result. The options are not tab
      // stops (tabIndex={-1}), so focus moves on to the next control.
      close();
      return;
    }
    if (e.key === 'Enter') {
      const active = showPanel && activeIndex >= 0 ? options[activeIndex] : undefined;
      if (active) {
        e.preventDefault();
        go(active.href);
      }
      return;
    }
    const isArrow = e.key === 'ArrowDown' || e.key === 'ArrowUp';
    const isJump = e.key === 'Home' || e.key === 'End';
    if (!isArrow && !isJump) return;
    if (options.length === 0) return;
    // Home/End belong to the caret while the popup is closed; only the arrows
    // reopen it (e.g. after Escape, with the query still in the box).
    if (isJump && !showPanel) return;
    e.preventDefault();
    if (!open) setOpen(true);
    const key = e.key;
    const last = options.length - 1;
    setActiveIndex((i) => {
      switch (key) {
        case 'ArrowDown': return i >= last ? 0 : i + 1; // wraps to the top
        case 'ArrowUp': return i <= 0 ? last : i - 1;   // wraps to the bottom
        case 'Home': return 0;
        default: return last;                           // End
      }
    });
  };

  const activeOptionId =
    showPanel && activeIndex >= 0 && options[activeIndex] ? optionDomId(options[activeIndex].id) : undefined;

  /*
   * Dark mode: the neutral surfaces and text tones below deliberately carry no
   * `dark:` variants. globals.css holds flat overrides — `html.dark .bg-white`
   * (#111827), `.border-gray-200` (#374151), `.text-gray-900` (#f3f4f6),
   * `.text-gray-500` (#9ca3af), `.hover:bg-gray-50` (#1f2937) and
   * `.bg-gray-100` (#374151) — which score (0,2,0), exactly like Tailwind's
   * `.dark .bg-gray-900`, and are emitted AFTER `@tailwind utilities`. A
   * `dark:` variant here would therefore lose on source order and be dead code
   * (the same trap documented in OnboardingChecklist.tsx). `shadow-lg` has no
   * flat override, so that one does get a real `dark:` value.
   *
   * The role/company badges moved off `text-gray-400`: it has no flat dark
   * override and, at 2.5:1 on white, it was the weakest tone here in *light*
   * mode too. `text-gray-500` clears AA in both themes.
   */
  return (
    <div className="relative w-56" ref={ref}>
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-gray-200 bg-white">
        <Search className="h-4 w-4 text-gray-500" aria-hidden="true" />
        <input
          ref={inputRef}
          data-testid="global-search-input"
          role="combobox"
          aria-expanded={showPanel}
          aria-controls={showPanel ? LISTBOX_ID : undefined}
          aria-activedescendant={activeOptionId}
          aria-autocomplete="list"
          aria-label={t.search.placeholder}
          autoComplete="off"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => queryIsSearchable && setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={t.search.placeholder}
          className="flex-1 text-sm outline-none bg-transparent"
        />
      </div>
      {showPanel && (
        <div
          id={LISTBOX_ID}
          role="listbox"
          aria-label={t.search.results}
          data-testid="global-search-listbox"
          className="absolute right-0 mt-2 w-72 max-h-96 overflow-y-auto rounded-xl border border-gray-200 bg-white shadow-lg dark:shadow-black/60 z-50"
        >
          {options.length === 0 ? (
            /* A role="option" row rather than a bare <div>: role="listbox"
               requires option children, and an aria-disabled option is both
               valid and reachable by a screen reader browsing the popup. */
            <div
              id={EMPTY_OPTION_ID}
              role="option"
              aria-disabled="true"
              aria-selected={false}
              data-testid="global-search-no-results"
              className="px-4 py-3 text-sm text-gray-500"
            >
              {t.search.noResults}
            </div>
          ) : (
            options.map((o, i) => (
              <button
                key={`${o.kind}-${o.id}`}
                type="button"
                id={optionDomId(o.id)}
                role="option"
                aria-selected={i === activeIndex}
                tabIndex={-1}
                data-testid={`global-search-option-${o.id}`}
                onClick={() => go(o.href)}
                onMouseEnter={() => setActiveIndex(i)}
                className={`block w-full text-left px-4 py-2.5 text-sm ${
                  i === activeIndex ? 'bg-gray-100' : 'hover:bg-gray-50'
                }`}
              >
                {o.kind === 'user' ? (
                  <>
                    <span className="font-medium text-gray-900">{o.hit.fullName}</span>
                    <span className="text-xs text-gray-500 ml-2">{o.hit.role}</span>
                    <span className="block text-xs text-gray-500 truncate">{o.hit.email}</span>
                  </>
                ) : (
                  <>
                    <span className="font-medium text-gray-900">{o.hit.name}</span>
                    <span className="text-xs text-gray-500 ml-2">{t.search.company}</span>
                  </>
                )}
              </button>
            ))
          )}
        </div>
      )}
      {/* Result count, announced once the debounce has settled. */}
      <div aria-live="polite" role="status" className="sr-only" data-testid="global-search-live">
        {liveMessage}
      </div>
    </div>
  );
}
