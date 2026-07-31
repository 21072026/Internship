'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ArrowLeft, Home } from 'lucide-react';
import { useT } from '@/i18n/client';
import { useIsNarrow } from '@/hooks/useIsNarrow';

/**
 * App shell for every /messages screen (#1006).
 *
 * On a phone a chat has to behave like a chat app: the viewport is the frame,
 * the message list is the only thing that scrolls, and the composer stays put.
 * The old layout was a plain document — the page title, the bubble list (its own
 * `max-h-[55vh]` scroller) and the composer all scrolled *together*, so writing a
 * reply meant scrolling the document down and the bubbles up: two nested scrolls
 * for one thread.
 *
 * So below `lg` this is a fixed-height flex column (`100dvh` minus any fixed
 * bottom bar — see `--fixed-bottom-inset`/#935): header, then a `min-h-0 flex-1`
 * content area. A chat page fills that area with `h-full` and scrolls internally;
 * a page that flows (the inbox) scrolls the area itself. Desktop keeps the plain
 * document flow.
 *
 * The header is also the way *out* on mobile, where there is no sidebar: a back
 * arrow (to the inbox, or to the role home when already there) and a home button.
 */

// Lets the current page name itself in the header — on a phone the person you are
// talking to is the only title worth the row.
const SetTitleContext = createContext<(title: string | null) => void>(() => {});

/** Publish this screen's header title for as long as the component is mounted. */
export function useMessagesHeaderTitle(title: string | null | undefined) {
  const setTitle = useContext(SetTitleContext);
  useEffect(() => {
    setTitle(title ?? null);
    return () => setTitle(null);
  }, [setTitle, title]);
}

export function MessagesShell({
  homeHref,
  children,
}: {
  homeHref: string;
  children: React.ReactNode;
}) {
  const t = useT();
  const pathname = usePathname();
  const narrow = useIsNarrow();
  const [title, setTitle] = useState<string | null>(null);
  const publishTitle = useCallback((next: string | null) => setTitle(next), []);

  // On the inbox itself, "back" leaves the messages area altogether.
  const atInbox = pathname === '/messages';
  const backHref = atInbox ? homeHref : '/messages';
  const backLabel = atInbox ? t.nav.dashboard : t.messages.title;

  return (
    <SetTitleContext.Provider value={publishTitle}>
      {/* Underscores are Tailwind's spaces: calc() needs them around the minus. */}
      <div className="flex h-[calc(100dvh_-_var(--fixed-bottom-inset))] flex-col overflow-hidden bg-gray-50 lg:h-auto lg:min-h-screen lg:overflow-visible">
        {/* `bg-white/95` is not the `bg-white` globals.css retints, so dark mode
            needs its own surface here. */}
        <header className="shrink-0 border-b border-gray-200 bg-white/95 backdrop-blur dark:border-gray-800 dark:bg-gray-900/95 lg:border-0 lg:bg-transparent lg:backdrop-blur-none dark:lg:bg-transparent">
          <div className="mx-auto flex w-full max-w-3xl items-center gap-1 px-2 py-1.5 lg:px-8 lg:pb-0 lg:pt-8">
            <Link
              href={backHref}
              data-testid="messages-back"
              aria-label={backLabel}
              className="inline-flex shrink-0 items-center gap-2 rounded-lg p-2 text-sm text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 lg:p-0 lg:hover:bg-transparent"
            >
              <ArrowLeft className="h-5 w-5 lg:h-4 lg:w-4" />
              {!narrow && <span>{backLabel}</span>}
            </Link>
            {/* Mobile-only, and deliberately the page's <h1>: the pages below drop
                their own heading on mobile, so the DOM keeps exactly one (also why
                this is rendered conditionally rather than hidden with `lg:hidden`
                — see useIsNarrow). */}
            {narrow && (
              <h1
                data-testid="messages-header-title"
                className="min-w-0 flex-1 truncate text-sm font-semibold text-gray-900 dark:text-gray-100"
              >
                {title ?? t.messages.title}
              </h1>
            )}
            {narrow && (
              <Link
                href={homeHref}
                data-testid="messages-home"
                aria-label={t.nav.dashboard}
                className="shrink-0 rounded-lg p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800"
              >
                <Home className="h-5 w-5" />
              </Link>
            )}
          </div>
        </header>
        {/* Scrolls on pages that flow (the inbox); a chat page takes `h-full` here
            and keeps its own scroller, so the document itself never scrolls. */}
        <main
          id="main-content"
          className="mx-auto min-h-0 w-full max-w-3xl flex-1 overflow-y-auto overscroll-contain px-4 pb-3 pt-2 lg:overflow-visible lg:px-8 lg:pb-8"
        >
          {children}
        </main>
      </div>
    </SetTitleContext.Provider>
  );
}
