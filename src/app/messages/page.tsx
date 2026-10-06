import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { MessageSquare, LifeBuoy, UserRound } from 'lucide-react';
import { PersonHoverCard } from '@/components/PersonHoverCard';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { getServerDictionary } from '@/i18n/server';
import { relativeTime } from '@/lib/relativeTime';
import { StartConversationPicker } from '@/components/StartConversationPicker';
import { MessagesLiveRefresh } from '@/components/MessagesLiveRefresh';
import { loadInbox } from '@/lib/inbox';

// Unified message inbox for every role: lists the viewer's conversation
// threads (mentor side or mentee side) with the other participant, a preview
// of the latest message, and an unread count — reachable from the header icon.
export default async function MessagesInboxPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/auth/signin?callbackUrl=/messages');
  const { locale, t } = await getServerDictionary();
  const me = session.user.id;

  // One read of the inbox for the page and the native app (src/lib/inbox.ts).
  const { threads: rows, candidates, supportUnread } = await loadInbox(me, (name) =>
    t.messages.projectGroup.replace('{name}', name),
  );
  const threads = rows.map((th) => ({
    key: `conv-${th.conversationId}`,
    href: `/messages/c/${th.conversationId}`,
    otherName: th.name,
    otherId: th.otherId,
    last: th.last,
    unread: th.unread,
  }));

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
        {threads.length === 0 ? (
          <p className="text-center py-10 text-gray-400">{t.messages.noThreads}</p>
        ) : (
          <div className="divide-y divide-gray-50">
            {threads.map((th) => {
              const preview = th.last
                ? `${th.last.senderId === me ? `${t.messages.you}: ` : ''}${th.last.body}`
                : t.messages.empty;
              return (
                <Link
                  key={th.key}
                  href={th.href}
                  className="flex items-center gap-3 py-3 hover:bg-gray-50 rounded-lg px-2"
                >
                  <div className="w-9 h-9 shrink-0 rounded-full bg-blue-100 flex items-center justify-center">
                    <MessageSquare className="h-4 w-4 text-blue-600" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className={`flex min-w-0 items-center gap-1.5 text-sm truncate ${th.unread > 0 ? 'font-bold text-gray-900' : 'font-medium text-gray-900'}`}>
                        <span className="truncate">{th.otherName}</span>
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
                        <span className="text-xs text-gray-400 shrink-0">{relativeTime(th.last.createdAt, locale)}</span>
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
              );
            })}
          </div>
        )}
        <StartConversationPicker candidates={candidates} />
      </Card>
    </div>
  );
}
