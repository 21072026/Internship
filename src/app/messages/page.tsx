import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { MessageSquare, LifeBuoy } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { prisma } from '@/lib/prisma';
import { getServerDictionary } from '@/i18n/server';
import { relativeTime } from '@/lib/relativeTime';
import { StartConversationPicker } from '@/components/StartConversationPicker';
import { createOrGetProjectConversation } from '@/lib/conversations';

// Unified message inbox for every role: lists the viewer's conversation
// threads (mentor side or mentee side) with the other participant, a preview
// of the latest message, and an unread count — reachable from the header icon.
export default async function MessagesInboxPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/auth/signin');
  const { locale, t } = await getServerDictionary();
  const me = session.user.id;

  const supportUnread = await prisma.supportMessage.count({
    where: { ticket: { requesterId: me }, senderId: { not: me }, readAt: null },
  });

  const myProjectIds = (
    await prisma.projectMember.findMany({ where: { userId: me }, select: { projectId: true } })
  ).map((m) => m.projectId);

  // Lazy-create chats for projects that predate #771, then list GROUP and DIRECT
  // conversations together so the project chat is reachable from the inbox.
  const projectGroupIds = (await Promise.all(myProjectIds.map(createOrGetProjectConversation)))
    .flatMap((conversation) => conversation ? [conversation.id] : []);
  const conversations = await prisma.conversation.findMany({
    where: {
      OR: [
        { type: 'DIRECT', participants: { some: { userId: me } } },
        ...(projectGroupIds.length ? [{ type: 'GROUP' as const, id: { in: projectGroupIds } }] : []),
      ],
    },
    select: {
      id: true,
      type: true,
      project: { select: { name: true } },
      participants: { select: { userId: true, user: { select: { fullName: true } } } },
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { body: true, createdAt: true, senderId: true },
      },
      _count: { select: { messages: { where: { readAt: null, senderId: { not: me } } } } },
    },
  });

  // Project co-members the viewer may start a DM with. Membership is the
  // permission (see canMessage in src/lib/conversations.ts), so this list is
  // derived on the server — the client never decides who is messageable.
  const coMemberRows = myProjectIds.length
    ? await prisma.projectMember.findMany({
        where: { projectId: { in: myProjectIds }, userId: { not: me } },
        select: { userId: true, user: { select: { fullName: true } }, project: { select: { name: true } } },
      })
    : [];

  const relations = await prisma.mentorshipRelation.findMany({
    where: { OR: [{ mentorId: me }, { menteeId: me }] },
    select: {
      id: true,
      mentorId: true,
      mentor: { select: { fullName: true } },
      mentee: { select: { fullName: true } },
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { body: true, createdAt: true, senderId: true },
      },
      _count: { select: { messages: { where: { readAt: null, senderId: { not: me } } } } },
    },
  });

  // Mentorship threads and conversations share one shape, so they sort and
  // render as a single list; `href` is what distinguishes the two routes.
  const threads = [
    ...relations.map((r) => ({
      key: `rel-${r.id}`,
      href: `/messages/${r.id}`,
      otherName: (r.mentorId === me ? r.mentee?.fullName : r.mentor?.fullName) ?? '—',
      last: r.messages[0] ?? null,
      unread: r._count.messages,
    })),
    ...conversations.map((c) => ({
      key: `conv-${c.id}`,
      href: `/messages/c/${c.id}`,
      otherName: c.type === 'GROUP'
        ? t.messages.projectGroup.replace('{name}', c.project?.name ?? '—')
        : c.participants.find((p) => p.userId !== me)?.user.fullName ?? '—',
      last: c.messages[0] ?? null,
      unread: c._count.messages,
    })),
  ].sort((a, b) => {
    const at = a.last?.createdAt?.getTime() ?? 0;
    const bt = b.last?.createdAt?.getTime() ?? 0;
    return bt - at;
  });

  // Offer only people we don't already have a conversation with — the existing
  // ones are in the list above. Deduped, since two shared projects would
  // otherwise surface the same person twice.
  const existingDmPartnerIds = new Set(
    conversations.flatMap((c) => c.participants.map((p) => p.userId)).filter((id) => id !== me),
  );
  const candidates = [
    ...new Map(
      coMemberRows
        .filter((row) => !existingDmPartnerIds.has(row.userId))
        .map((row) => [row.userId, { id: row.userId, fullName: row.user.fullName, projectName: row.project.name }]),
    ).values(),
  ].sort((a, b) => a.fullName.localeCompare(b.fullName));

  return (
    <div>
      <div className="mb-6">
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
            <span className="ml-1 shrink-0 min-w-[20px] h-5 px-1.5 rounded-full bg-red-500 text-white text-[11px] font-bold flex items-center justify-center">
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
                      <span className={`text-sm truncate ${th.unread > 0 ? 'font-bold text-gray-900' : 'font-medium text-gray-900'}`}>
                        {th.otherName}
                      </span>
                      {th.last && (
                        <span className="text-xs text-gray-400 shrink-0">{relativeTime(th.last.createdAt, locale)}</span>
                      )}
                    </div>
                    <p className={`text-xs truncate mt-0.5 ${th.unread > 0 ? 'text-gray-700' : 'text-gray-400'}`}>{preview}</p>
                  </div>
                  {th.unread > 0 && (
                    <span className="ml-1 shrink-0 min-w-[20px] h-5 px-1.5 rounded-full bg-red-500 text-white text-[11px] font-bold flex items-center justify-center">
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
