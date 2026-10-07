import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { enforceRateLimit } from '@/lib/rateLimit';
import { getThreadIfAllowed } from '@/lib/messaging';
import { conversationForRelation, getConversationIfAllowed } from '@/lib/conversations';
import { withTenantScope } from '@/lib/orgContext';
import { withRequestScope } from '@/lib/requestContext';
import { likeLiteral, searchSnippet } from '@/lib/messagePage';

// GET ?q= — search the caller's own message threads (#1609).
//
// WHOSE THREADS. Only threads the caller is IN: the mentorships they are the
// mentor or mentee of, and the conversations they are a participant of. Not
// every thread an admin may open — reading someone's thread on purpose is one
// thing, having it surface in a keyword search is another, and the search box
// sits in everyone's inbox. And then every thread a hit comes from is put
// through the same gate opening it would (getThreadIfAllowed /
// getConversationIfAllowed), so a search can never show a line from a thread
// the caller could not open: a project room they have left keeps its
// participant row but no longer opens, and its messages stay out.
//
// HOW. A bounded `contains` (MySQL LIKE, case-insensitive under the table's
// collation) over the caller's threads only, newest first, `take` 30. Not a
// FULLTEXT index: that needs Prisma's `fullTextIndex` preview feature, and
// InnoDB full-text matches whole words with a minimum token length, so a
// Turkish or German word with a suffix, or a three-letter fragment, would not
// be found — while the people searching want "where did we write about the
// CV". The scan is bounded by the caller's own threads (indexed by thread id).
//
// What a hit carries is what opening the thread would show anyway: never a
// message deleted for everyone, never one the caller deleted for themselves.
//
// Messaging is free for mentors and mentees — nothing here is plan-gated.

const MAX_RESULTS = 30;
const MIN_QUERY = 2;
const MAX_QUERY = 100;

export async function GET(request: Request) {
  return withRequestScope(request, () => handleGet(request));
}

async function handleGet(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const limited = enforceRateLimit(request, 'message-search', { limit: 30, windowMs: 60 * 1000, subject: session.user.id });
  if (limited) return limited;

  return await withTenantScope(session, async () => {
    const params = new URL(request.url).searchParams;
    const q = (params.get('q') ?? '').trim();
    if (q.length < MIN_QUERY || q.length > MAX_QUERY) {
      return NextResponse.json({ error: `q must be ${MIN_QUERY}-${MAX_QUERY} characters` }, { status: 400 });
    }
    const me = session.user.id;

    const [relations, memberships] = await Promise.all([
      prisma.mentorshipRelation.findMany({ where: { OR: [{ mentorId: me }, { menteeId: me }] }, select: { id: true } }),
      prisma.conversationParticipant.findMany({ where: { userId: me }, select: { conversationId: true } }),
    ]);
    const relationIds = relations.map((r) => r.id);
    const conversationIds = memberships.map((m) => m.conversationId);
    if (relationIds.length === 0 && conversationIds.length === 0) return NextResponse.json({ results: [] });

    const rows = await prisma.message.findMany({
      where: {
        // Both sets are the caller's OWN threads, so the OR cannot reach a
        // sibling layer the way an OR in the thread read would (route.ts).
        OR: [
          ...(relationIds.length ? [{ relationId: { in: relationIds } }] : []),
          ...(conversationIds.length ? [{ conversationId: { in: conversationIds } }] : []),
        ],
        body: { contains: likeLiteral(q) },
        deletedForEveryoneAt: null,
        hiddenFor: { none: { userId: me } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: MAX_RESULTS,
      select: { id: true, body: true, createdAt: true, senderId: true, relationId: true, conversationId: true },
    });

    // The gate, once per thread a hit came from. A message adopted into its
    // pair's conversation (#1156) carries both links and is opened as the
    // conversation — that is the thread the inbox shows.
    const threadOf = (m: (typeof rows)[number]) =>
      m.conversationId ? ({ kind: 'conversation', id: m.conversationId } as const) : ({ kind: 'relation', id: m.relationId! } as const);
    const verdicts = new Map<string, { name: string; href: string } | null>();
    const names = new Map<string, string>();
    for (const m of rows) {
      const thread = threadOf(m);
      const key = `${thread.kind}:${thread.id}`;
      if (verdicts.has(key)) continue;
      if (thread.kind === 'conversation') {
        const conversation = await getConversationIfAllowed(session.user, thread.id);
        if (!conversation) { verdicts.set(key, null); continue; }
        for (const p of conversation.participants) names.set(p.user.id, p.user.fullName);
        let name: string;
        if (conversation.type === 'GROUP' && conversation.projectId) {
          name = (await prisma.project.findUnique({ where: { id: conversation.projectId }, select: { name: true } }))?.name ?? '';
        } else {
          name = conversation.participants.filter((p) => p.userId !== me).map((p) => p.user.fullName).join(', ');
        }
        verdicts.set(key, { name, href: `/messages/c/${thread.id}` });
      } else {
        const rel = await getThreadIfAllowed(session.user, thread.id);
        if (!rel) { verdicts.set(key, null); continue; }
        names.set(rel.mentor.id, rel.mentor.fullName);
        names.set(rel.mentee.id, rel.mentee.fullName);
        // A mentorship's thread lives in the pair's conversation (#1156); a hit
        // not adopted into it yet is adopted here — the same idempotent step
        // the inbox takes on every render — so the link opens the one thread
        // where the message actually shows, at the message.
        const adopted = await conversationForRelation(rel);
        verdicts.set(key, {
          name: rel.mentorId === me ? rel.mentee.fullName : rel.mentor.fullName,
          href: adopted ? `/messages/c/${adopted.id}` : `/messages/${thread.id}`,
        });
      }
    }

    const results = rows.flatMap((m) => {
      const thread = threadOf(m);
      const verdict = verdicts.get(`${thread.kind}:${thread.id}`);
      if (!verdict) return [];
      return [{
        id: m.id,
        snippet: searchSnippet(m.body, q),
        createdAt: m.createdAt,
        senderId: m.senderId,
        senderName: names.get(m.senderId) ?? null,
        mine: m.senderId === me,
        thread: { kind: thread.kind, id: thread.id, name: verdict.name },
        // Opens the thread at the hit: the view pages back until it has it.
        href: `${verdict.href}?m=${m.id}`,
      }];
    });
    return NextResponse.json({ results });
  });
}
