'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Building2, Keyboard, Mail, MessageSquare, Search, Sun, User as UserIcon, type LucideIcon } from 'lucide-react';
import { useT } from '@/i18n/client';
import { useModalFocus } from '@/components/ui/useModalFocus';
import { ShortcutsSheet } from '@/components/ShortcutsSheet';
import { navLinksForRole, type NavRole } from '@/lib/navLinks';
import { isMacPlatform, isTypingTarget } from '@/lib/shortcuts';
import { THEME_CYCLE, applyTheme, readStoredTheme } from '@/lib/theme';

interface UserHit { id: string; fullName: string; email: string; role: string; relationId?: string | null }
interface CompanyHit { id: string; name: string }

type GroupId = 'goTo' | 'search' | 'actions';

interface PaletteOption {
  /** Stable key — also the DOM id (aria-activedescendant) and the testid suffix. */
  key: string;
  group: GroupId;
  label: string;
  hint?: string;
  icon: LucideIcon;
  href?: string;
  run?: () => void;
}

const GROUP_ORDER: GroupId[] = ['goTo', 'search', 'actions'];
const LISTBOX_ID = 'command-palette-listbox';
const optionDomId = (key: string) => `command-palette-option-${key}`;
const groupHeadingId = (group: GroupId) => `command-palette-group-${group}`;
/** How many destinations to show before the user has typed anything. */
const GOTO_PREVIEW = 6;

const userHref = (u: UserHit) =>
  u.relationId ? `/mentor/mentees/${u.relationId}` : u.role === 'MENTEE' ? `/admin/candidates/${u.id}` : '/admin/users';

/**
 * ⌘K command palette (#2079), mounted once per authenticated shell.
 *
 * It reuses GlobalSearch's combobox shape (flat option list → cursor →
 * `aria-activedescendant`) rather than inventing a second one, and
 * `useModalFocus` for the trap / Escape / focus return. Two rules it must keep:
 * the "Go to" entries come from `lib/navLinks` (the same list the sidebar
 * renders, so an entry can never point at a page this role is refused), and no
 * option performs a privileged write — every one is a link or a local UI action.
 *
 * No `dark:` variants on the gray/white utilities, same as GlobalSearch:
 * globals.css's flat `html.dark .bg-white` rules (specificity 0,2,1) outrank
 * Tailwind's `.dark .dark\:bg-*` (0,2,0), so a variant here would be dead
 * code. Those rules already paint the panel #111827 with #f3f4f6 / #9ca3af
 * text, a #374151 active row and a #1f2937 hover row.
 */
export function CommandPalette({ role }: { role: NavRole }) {
  const t = useT();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [isMac, setIsMac] = useState(false);
  const [q, setQ] = useState('');
  const [users, setUsers] = useState<UserHit[]>([]);
  const [companies, setCompanies] = useState<CompanyHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const dialogRef = useModalFocus<HTMLDivElement>(open, () => setOpen(false));

  // Platform sniff after mount only — `navigator` is absent during SSR.
  useEffect(() => setIsMac(isMacPlatform()), []);

  // /api/search is 401 for anyone who is not an admin or a mentor, so a mentee's
  // palette never asks. The server stays the authority either way.
  const canSearch = role === 'ADMIN' || role === 'MENTOR';

  const openPalette = useCallback(() => {
    setSheetOpen(false);
    setQ('');
    setUsers([]);
    setCompanies([]);
    setActiveIndex(0);
    setOpen(true);
  }, []);

  // Global bindings. Both live here so one mounted component owns every
  // shortcut the registry advertises.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      // `useModalFocus` assumes one blocking modal at a time, so a global
      // shortcut must not stack a second one on top of an open dialog.
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        if (isTypingTarget(e.target)) return;
        e.preventDefault();
        openPalette();
        return;
      }
      if (e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (isTypingTarget(e.target)) return;
        e.preventDefault();
        setOpen(false);
        setSheetOpen(true);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [openPalette]);

  // Debounced people/company lookup, same 250 ms as the header search.
  useEffect(() => {
    if (!open || !canSearch || q.trim().length < 2) {
      setUsers([]); setCompanies([]); setLoading(false);
      return;
    }
    setLoading(true);
    let cancelled = false;
    const id = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        const d = await res.json();
        if (cancelled) return;
        setUsers(d.users ?? []);
        setCompanies(d.companies ?? []);
      } catch {
        if (!cancelled) { setUsers([]); setCompanies([]); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 250);
    return () => { cancelled = true; clearTimeout(id); };
  }, [q, open, canSearch]);

  const go = useCallback((href: string) => {
    setOpen(false);
    router.push(href);
  }, [router]);

  const cycleTheme = useCallback(() => {
    const current = readStoredTheme();
    const next = THEME_CYCLE[(THEME_CYCLE.indexOf(current) + 1) % THEME_CYCLE.length];
    applyTheme(next);
    // Best-effort account persist, exactly as ThemeToggle does.
    fetch('/api/profile', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ theme: next }),
    }).catch(() => {});
    setOpen(false);
  }, []);

  const navLabels = t.nav as Record<string, string>;

  // Every action is a link or a local UI toggle — never a privileged write from
  // the client. The destinations are the same role-scoped pages the sidebar
  // already offers, so none of them can 403.
  const actions = useMemo<PaletteOption[]>(() => {
    const list: PaletteOption[] = [];
    if (role === 'ADMIN') {
      list.push({ key: 'action-invite', group: 'actions', label: t.commandPalette.actions.invite, icon: Mail, href: '/admin/invite' });
      list.push({ key: 'action-add-company', group: 'actions', label: t.commandPalette.actions.addCompany, icon: Building2, href: '/admin/companies' });
    } else if (role === 'MENTOR') {
      list.push({ key: 'action-invite', group: 'actions', label: t.commandPalette.actions.invite, icon: Mail, href: '/mentor/invite' });
    }
    list.push({ key: 'action-messages', group: 'actions', label: t.commandPalette.actions.messages, icon: MessageSquare, href: '/messages' });
    list.push({ key: 'action-theme', group: 'actions', label: t.commandPalette.actions.toggleTheme, icon: Sun, run: cycleTheme });
    list.push({
      key: 'action-shortcuts',
      group: 'actions',
      label: t.commandPalette.actions.shortcuts,
      icon: Keyboard,
      run: () => { setOpen(false); setSheetOpen(true); },
    });
    return list;
  }, [role, t, cycleTheme]);

  const options = useMemo<PaletteOption[]>(() => {
    const needle = q.trim().toLowerCase();
    const matches = (label: string) => !needle || label.toLowerCase().includes(needle);

    const links = navLinksForRole(role)
      .map((l) => ({ link: l, label: navLabels[l.key] ?? l.key }))
      .filter(({ label }) => matches(label));
    const goTo: PaletteOption[] = (needle ? links : links.slice(0, GOTO_PREVIEW)).map(({ link, label }) => ({
      key: `goto-${link.href.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '')}`,
      group: 'goTo',
      label,
      hint: link.href,
      icon: link.icon,
      href: link.href,
    }));

    const hits: PaletteOption[] = [
      ...users.map((u) => ({
        key: `user-${u.id}`, group: 'search' as const, label: u.fullName, hint: u.email, icon: UserIcon, href: userHref(u),
      })),
      ...companies.map((c) => ({
        key: `company-${c.id}`, group: 'search' as const, label: c.name, hint: t.search.company, icon: Building2, href: '/admin/companies',
      })),
    ];

    return [...goTo, ...hits, ...actions.filter((a) => matches(a.label))];
  }, [q, role, navLabels, users, companies, actions, t.search.company]);

  // Reset the cursor whenever the candidate set changes shape, so the highlight
  // can never point past the end of the list.
  useEffect(() => { setActiveIndex(0); }, [q]);
  useEffect(() => {
    setActiveIndex((i) => (options.length === 0 ? 0 : Math.min(i, options.length - 1)));
  }, [options.length]);

  // Keep the highlighted option inside the scroll area.
  useEffect(() => {
    if (!open) return;
    const key = options[activeIndex]?.key;
    if (!key || !listRef.current) return;
    document.getElementById(optionDomId(key))?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, options, open]);

  const select = useCallback((option: PaletteOption | undefined) => {
    if (!option) return;
    if (option.run) option.run();
    else if (option.href) go(option.href);
  }, [go]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      select(options[activeIndex]);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    if (options.length === 0) return;
    e.preventDefault();
    setActiveIndex((i) => {
      if (e.key === 'Home') return 0;
      if (e.key === 'End') return options.length - 1;
      if (e.key === 'ArrowDown') return i >= options.length - 1 ? 0 : i + 1;
      return i <= 0 ? options.length - 1 : i - 1;
    });
  };

  const activeKey = options[activeIndex]?.key;
  const showEmpty = options.length === 0;
  const statusText = loading
    ? t.commandPalette.searching
    : showEmpty
      ? t.commandPalette.noResults
      : t.commandPalette.resultCount.replace('{count}', String(options.length));

  return (
    <>
      {open && (
        <div
          className="fixed inset-0 z-[200] flex items-start justify-center bg-black/50 p-4 pt-[10vh]"
          onClick={() => setOpen(false)}
        >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label={t.commandPalette.title}
            data-testid="command-palette"
            tabIndex={-1}
            className="w-full max-w-xl overflow-hidden rounded-xl bg-white shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b border-gray-200 px-4 py-3">
              <Search className="h-4 w-4 text-gray-500" aria-hidden="true" />
              <input
                data-testid="command-palette-input"
                role="combobox"
                aria-expanded={!showEmpty}
                aria-controls={showEmpty ? undefined : LISTBOX_ID}
                aria-activedescendant={activeKey ? optionDomId(activeKey) : undefined}
                aria-autocomplete="list"
                aria-label={t.commandPalette.placeholder}
                autoComplete="off"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder={t.commandPalette.placeholder}
                className="flex-1 bg-transparent text-sm text-gray-900 outline-none"
              />
            </div>

            <div ref={listRef} className="max-h-80 overflow-y-auto">
              {showEmpty ? (
                <p data-testid="command-palette-empty" className="px-4 py-6 text-center text-sm text-gray-500">
                  {loading ? t.commandPalette.searching : t.commandPalette.noResults}
                </p>
              ) : (
                <div id={LISTBOX_ID} role="listbox" aria-label={t.commandPalette.title}>
                  {GROUP_ORDER.map((group) => {
                    const inGroup = options.filter((o) => o.group === group);
                    if (inGroup.length === 0) return null;
                    return (
                      <div key={group} role="group" aria-labelledby={groupHeadingId(group)}>
                        <p
                          id={groupHeadingId(group)}
                          className="px-4 pt-3 pb-1 text-xs font-semibold uppercase tracking-wide text-gray-500"
                        >
                          {t.commandPalette.groups[group]}
                        </p>
                        {inGroup.map((option) => {
                          const index = options.indexOf(option);
                          const Icon = option.icon;
                          const active = index === activeIndex;
                          return (
                            <div
                              key={option.key}
                              id={optionDomId(option.key)}
                              data-testid={`command-palette-option-${option.key}`}
                              role="option"
                              aria-selected={active}
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => select(option)}
                              className={`flex cursor-pointer items-center gap-3 px-4 py-2.5 text-sm ${
                                active
                                  ? 'bg-gray-100 ring-2 ring-inset ring-blue-500'
                                  : 'hover:bg-gray-50'
                              }`}
                            >
                              <Icon className="h-4 w-4 flex-shrink-0 text-gray-400" aria-hidden="true" />
                              <span className="truncate text-gray-900">{option.label}</span>
                              {option.hint && (
                                <span className="ml-auto truncate pl-3 text-xs text-gray-500">
                                  {option.hint}
                                </span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="flex items-center justify-between gap-3 border-t border-gray-200 px-4 py-2">
              <span className="text-xs text-gray-500">{t.commandPalette.hint}</span>
              <button
                type="button"
                data-testid="command-palette-shortcuts"
                onClick={() => { setOpen(false); setSheetOpen(true); }}
                className="rounded-lg px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 hover:text-gray-900"
              >
                {t.commandPalette.footerHint.replace('{key}', '?')}
              </button>
            </div>

            {/* Result count for assistive tech. */}
            <p role="status" aria-live="polite" className="sr-only" data-testid="command-palette-status">
              {statusText}
            </p>
          </div>
        </div>
      )}

      <ShortcutsSheet open={sheetOpen} isMac={isMac} onClose={() => setSheetOpen(false)} />
    </>
  );
}
