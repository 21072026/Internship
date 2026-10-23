import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { MessageSquare, LifeBuoy, UserRound, Pin, BellOff } from 'lucide-react';
import { PersonHoverCard } from '@/components/PersonHoverCard';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { getServerDictionary } from '@/i18n/server';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { StartConversationPicker } from '@/components/StartConversationPicker';
import { MessagesLiveRefresh } from '@/components/MessagesLiveRefresh';
import { MessageSearch } from '@/components/MessageSearch';
import { CandidateOutreachPanel } from '@/components/CandidateOutreachPanel';
import { loadInbox } from '@/lib/inbox';
import { ThreadStateMenu } from '@/components/ThreadStateMenu';
import { INBOX_FILTERS, filterInbox, parseInboxFilter } from '@/lib/conversationState';

// Unified message inbox for every role: lists the viewer's conversation
// threads (mentor side or mentee side) with the other participant, a preview
// of the latest message, and an unread count — reachable from the header icon.
export default async function MessagesInboxPage({ searchParams }: { searchParams: Promise<{ filter?: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/auth/signin?callbackUrl=/messages');
  const { t } = await getServerDictionary();
  const me = session.user.id;
  // Inbox filter chips (#1609): a URL parameter, so a filter survives a reload
  // and the back button, and the page stays a server render.
  const filter = parseInboxFilter((await searchParams).filter);

  // One read of the inbox for the page and the native app (src/lib/inbox.ts).
  const { threads: rows, candidates, supportUnread } = await loadInbox(me, (name) =>
    t.messages.projectGroup.replace('{name}', name),
  );
  const threads = filterInbox(rows, filter).map((th) => ({
    key: `conv-${th.conversationId}`,
    conversationId: th.conversationId,
    href: `/messages/c/${th.conversationId}`,
    otherName: th.name,
    otherId: th.otherId,
    last: th.last,
    unread: th.unread,
    pinned: th.pinned,
    muted: th.muted,
    archived: th.archived,
  }));
  const F = t.messages.inboxFilters;
  const emptyText = filter === 'unread' ? F.emptyUnread : filter === 'pinned' ? F.emptyPinned : filter === 'archived' ? F.emptyArchived : t.messages.noThreads;

  return (
    <div>
      {/* This page's numbers are rendered on the server, so a message arriving
          while it is on screen would otherwise go unnoticed until a navigation
          (#1464). */}
      <MessagesLiveRefresh />
      {/* Mobile gets its title from the shell header (see MessagesShell), so this
          block only shows where there is room for it. */}
      <div className="hidden lg:block mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.messages.title}</h1>
        <p className="text-gray-500 mt-1">{t.messages.inboxSubtitle}</p>
      </div>
      {/* Search across the viewer's own threads (#1609). */}
      <MessageSearch />
      {/* Company → candidate message requests (#1840): the deciders' queue, the
          candidate's open channels, the company's own requests. Empty → nothing. */}
      <CandidateOutreachPanel role={session.user.role} />
      <Card>
        <CardHeader><CardTitle>{t.messages.threads}</CardTitle></CardHeader>
        {/* Pinned support conversation (#593) — every role's line to the admins. */}
        <Link
          href="/messages/support"
          data-testid="support-entry"
          className="flex items-center gap-3 py-3 hover:bg-gray-50 rounded-lg px-2 border-b border-gray-100 dark:border-gray-800"
        >
          <div className="w-9 h-9 shrink-0 rounded-full bg-amber-100 flex items-center justify-center">
            <LifeBuoy className="h-4 w-4 text-amber-600" />
          </div>
          <div className="min-w-0 flex-1">
            <span className={`text-sm ${supportUnread > 0 ? 'font-bold' : 'font-medium'} text-gray-900 dark:text-gray-100`}>{t.support.title}</span>
            <p className="text-xs text-gray-400 mt-0.5">{t.support.pinnedHint}</p>
          </div>
          {supportUnread > 0 && (
            <span className="ml-1 shrink-0 min-w-[20px] h-5 px-1.5 rounded-full bg-red-600 text-white text-[11px] font-bold flex items-center justify-center">
              {supportUnread > 9 ? '9+' : supportUnread}
            </span>
          )}
        </Link>
        <nav aria-label={F.label} className="flex flex-wrap gap-2 border-b border-gray-100 px-2 py-3 dark:border-gray-800" data-testid="inbox-filters">
          {/* Plain anchors, not <Link> (#1609): the inbox re-renders itself
              with router.refresh() on every live signal (MessagesLiveRefresh),
              and a refresh committing while a client-side navigation to the
              same route is in flight swallowed that navigation — in the
              production build a chip click could simply do nothing. A full
              load of this server-rendered page costs the same and cannot be
              raced. */}
          {INBOX_FILTERS.map((key) => (
            // eslint-disable-next-line @next/next/no-html-link-for-pages -- see the comment above
            <a
              key={key}
              href={key === 'all' ? '/messages' : `/messages?filter=${key}`}
              aria-current={filter === key ? 'page' : undefined}
              data-testid={`inbox-filter-${key}`}
              className={`rounded-full px-3 py-1 text-xs font-medium ${
                filter === key
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700'
              }`}
            >
              {F[key]}
            </a>
          ))}
        </nav>
        {threads.length === 0 ? (
          <p className="text-center py-10 text-gray-400" data-testid="inbox-empty">{emptyText}</p>
        ) : (
          <div className="divide-y divide-gray-50">
            {threads.map((th) => {
              const preview = th.last
                ? `${th.last.senderId === me ? `${t.messages.you}: ` : ''}${th.last.body}`
                : t.messages.empty;
              return (
                // The row's actions sit BESIDE the link, never inside it: a
                // button nested in an anchor is two interactive elements in one.
                <div key={th.key} className="flex items-center gap-1" data-testid={`inbox-thread-${th.conversationId}`}>
                <Link
                  href={th.href}
                  className="flex min-w-0 flex-1 items-center gap-3 py-3 hover:bg-gray-50 rounded-lg px-2"
                >
                  <div className="w-9 h-9 shrink-0 rounded-full bg-blue-100 flex items-center justify-center">
                    <MessageSquare className="h-4 w-4 text-blue-600" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className={`flex min-w-0 items-center gap-1.5 text-sm truncate ${th.unread > 0 ? 'font-bold text-gray-900' : 'font-medium text-gray-900'}`}>
                        <span className="truncate">{th.otherName}</span>
                        {th.pinned && <Pin className="h-3.5 w-3.5 shrink-0 text-gray-400" aria-label={t.messages.threadState.pinned} data-testid="thread-pinned" />}
                        {th.muted && <BellOff className="h-3.5 w-3.5 shrink-0 text-gray-400" aria-label={t.messages.threadState.muted} data-testid="thread-muted" />}
                        {/* The whole row is a link into the thread, so the name
                            itself cannot be the card's trigger — it gets its own
                            icon, same as the email composer's checkbox rows.
                            The icon is aria-hidden, so `name` is what gives this
                            trigger its accessible name (see PersonHoverCard). */}
                        {th.otherId && (
                          /* The 14x14 icon is the whole visible trigger, but WCAG
                             2.2 target-size (AA) asks for 24x24 — so the trigger
                             box is sized, not the glyph (#2131). */
                          <PersonHoverCard
                            personId={th.otherId}
                            name={th.otherName}
                            className="no-underline inline-flex h-6 w-6 shrink-0 items-center justify-center"
                          >
                            <UserRound className="h-3.5 w-3.5 text-gray-400 hover:text-blue-600" aria-hidden />
                          </PersonHoverCard>
                        )}
                      </span>
                      {th.last && (
                        <RelativeTime date={th.last.createdAt} className="text-xs text-gray-400 shrink-0" />
                      )}
                    </div>
                    <p className={`text-xs truncate mt-0.5 ${th.unread > 0 ? 'text-gray-700' : 'text-gray-400'}`}>{preview}</p>
                  </div>
                  {th.unread > 0 && (
                    <span className="ml-1 shrink-0 min-w-[20px] h-5 px-1.5 rounded-full bg-red-600 text-white text-[11px] font-bold flex items-center justify-center">
                      {th.unread > 9 ? '9+' : th.unread}
                    </span>
                  )}
                </Link>
                <ThreadStateMenu conversationId={th.conversationId} pinned={th.pinned} muted={th.muted} archived={th.archived} />
                </div>
              );
            })}
          </div>
        )}
        <StartConversationPicker candidates={candidates} />
      </Card>
    </div>
  );
}
