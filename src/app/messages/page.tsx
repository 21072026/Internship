import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { MessageSquare } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { prisma } from '@/lib/prisma';
import { getServerDictionary } from '@/i18n/server';
import { relativeTime } from '@/lib/relativeTime';

// Unified message inbox for every role: lists the viewer's conversation
// threads (mentor side or mentee side) with the other participant, a preview
// of the latest message, and an unread count — reachable from the header icon.
export default async function MessagesInboxPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/auth/signin');
  const { locale, t } = await getServerDictionary();
  const me = session.user.id;

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

  // Sort by latest activity (most recent message first; then start order).
  const threads = relations
    .map((r) => {
      const last = r.messages[0] ?? null;
      const otherName = (r.mentorId === me ? r.mentee?.fullName : r.mentor?.fullName) ?? '—';
      return { id: r.id, otherName, last, unread: r._count.messages };
    })
    .sort((a, b) => {
      const at = a.last?.createdAt?.getTime() ?? 0;
      const bt = b.last?.createdAt?.getTime() ?? 0;
      return bt - at;
    });

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.messages.title}</h1>
        <p className="text-gray-500 mt-1">{t.messages.inboxSubtitle}</p>
      </div>
      <Card>
        <CardHeader><CardTitle>{t.messages.threads}</CardTitle></CardHeader>
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
                  key={th.id}
                  href={`/messages/${th.id}`}
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
      </Card>
    </div>
  );
}
