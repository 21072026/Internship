import { prisma } from '@/lib/prisma';
import { conversationForRelation, createOrGetProjectConversation } from '@/lib/conversations';

// The message inbox, read once for every surface that lists it: the /messages
// page and GET /api/conversations (the native app, #2775). Two copies of this
// query would drift — which threads count, which ones get created on first
// visit, what "unread" means — so both call this.

export interface InboxThread {
  conversationId: string;
  type: 'DIRECT' | 'GROUP';
  /** The other person (1:1), or the project's name (group room). */
  name: string;
  /** Who a 1:1 row is about; null for a group room. */
  otherId: string | null;
  last: { body: string; createdAt: Date; senderId: string } | null;
  unread: number;
}

export interface Inbox {
  threads: InboxThread[];
  /** Project co-members the viewer may start a DM with (server-derived, #771). */
  candidates: { id: string; fullName: string; projectName: string }[];
  supportUnread: number;
}

/**
 * @param groupName renders a project room's name (the caller's dictionary,
 *   `t.messages.projectGroup`), so this stays free of i18n.
 */
export async function loadInbox(me: string, groupName: (projectName: string) => string): Promise<Inbox> {
  const supportUnread = await prisma.supportMessage.count({
    where: { ticket: { requesterId: me }, senderId: { not: me }, readAt: null },
  });

  const myProjectIds = (
    await prisma.projectMember.findMany({ where: { userId: me }, select: { projectId: true } })
  ).map((m) => m.projectId);

  // Every mentorship the viewer is in, resolved to the pair's one conversation
  // and taking the relation's own messages with it (#1156). This list used to
  // render mentorship threads *alongside* conversations, so anyone reachable
  // both ways — as a mentee and as a project co-member — appeared twice, with
  // half of the history behind each row. Runs before the query below so the
  // adopted messages count towards the preview and the unread badge.
  const myRelations = await prisma.mentorshipRelation.findMany({
    where: { OR: [{ mentorId: me }, { menteeId: me }] },
    select: { id: true, mentorId: true, menteeId: true },
  });
  await Promise.all(myRelations.map(conversationForRelation));

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

  // One row per conversation — which, for a 1:1 chat, means one row per person.
  const threads: InboxThread[] = conversations
    .map((c) => {
      const other = c.type === 'GROUP' ? null : c.participants.find((p) => p.userId !== me) ?? null;
      return {
        conversationId: c.id,
        type: c.type as InboxThread['type'],
        name: c.type === 'GROUP' ? groupName(c.project?.name ?? '—') : other?.user.fullName ?? '—',
        otherId: other?.userId ?? null,
        last: c.messages[0] ?? null,
        unread: c._count.messages,
      };
    })
    .sort((a, b) => (b.last?.createdAt?.getTime() ?? 0) - (a.last?.createdAt?.getTime() ?? 0));

  // Offer only people we don't already have a DM with — those threads are in
  // the list above. DIRECT only: every co-member is also a participant of the
  // shared project's GROUP chat, so counting group participants here would
  // empty the picker for everyone who is in a project. Deduped, since two
  // shared projects would otherwise surface the same person twice.
  const existingDmPartnerIds = new Set(
    conversations
      .filter((c) => c.type === 'DIRECT')
      .flatMap((c) => c.participants.map((p) => p.userId))
      .filter((id) => id !== me),
  );
  const candidates = [
    ...new Map(
      coMemberRows
        .filter((row) => !existingDmPartnerIds.has(row.userId))
        .map((row) => [row.userId, { id: row.userId, fullName: row.user.fullName, projectName: row.project.name }]),
    ).values(),
  ].sort((a, b) => a.fullName.localeCompare(b.fullName));

  return { threads, candidates, supportUnread };
}
