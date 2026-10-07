import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import type { Prisma } from '@prisma/client';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { getSetting } from '@/lib/settings';
import {
  contextAround,
  detectContactDetails,
  maskContact,
  matchWatchKeywords,
  parseWatchKeywords,
} from '@/lib/safeguarding';

// GET /api/admin/safeguarding — the review queue (#2056).
//
// ADMIN only, checked here at the route; tenant-scoped by a hand-written
// `orgId` conjunct (the middleware is a no-op while MT_ENFORCE_ISOLATION is
// off, #2542). The flag row holds only a masked term; the CONTEXT shown to the
// admin is recomputed from the live message body, so a message that has since
// been deleted or masked by retention shows as removed rather than leaking the
// text the flag was raised on.
//
// Query: status (open|reviewed|all, default open), kind (CONTACT_DETAIL|KEYWORD),
// q (sender name or matched term), page, pageSize (≤100).

const KINDS = ['CONTACT_DETAIL', 'KEYWORD'] as const;
type Kind = (typeof KINDS)[number];

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const url = new URL(request.url);
  const statusParam = url.searchParams.get('status');
  const status = statusParam === 'reviewed' || statusParam === 'all' ? statusParam : 'open';
  const kindParam = url.searchParams.get('kind');
  const kind = KINDS.find((k) => k === kindParam) ?? null;
  const q = (url.searchParams.get('q') ?? '').trim().slice(0, 100);
  const pageSize = Math.min(Math.max(parseInt(url.searchParams.get('pageSize') || '25', 10) || 25, 1), 100);
  const page = Math.max(parseInt(url.searchParams.get('page') || '1', 10) || 1, 1);
  const orgId = await settingsOrgOf(session);

  return withTenantScope(session, async () => {
    // Sender names live on User, and Message.senderId has no relation to it —
    // so a name search resolves to sender ids first, inside the same org.
    const nameMatches = q
      ? (
          await prisma.user.findMany({
            where: { orgId, fullName: { contains: q } },
            select: { id: true },
            take: 200,
          })
        ).map((u) => u.id)
      : [];

    const base: Prisma.SafeguardingFlagWhereInput = {
      orgId,
      ...(kind ? { kind } : {}),
      ...(q ? { OR: [{ matchedTerm: { contains: q } }, { message: { senderId: { in: nameMatches } } }] } : {}),
    };
    const where: Prisma.SafeguardingFlagWhereInput = {
      ...base,
      ...(status === 'open' ? { reviewedAt: null } : status === 'reviewed' ? { reviewedAt: { not: null } } : {}),
    };

    const [total, open, reviewed, flags] = await Promise.all([
      prisma.safeguardingFlag.count({ where }),
      prisma.safeguardingFlag.count({ where: { ...base, reviewedAt: null } }),
      prisma.safeguardingFlag.count({ where: { ...base, reviewedAt: { not: null } } }),
      prisma.safeguardingFlag.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          kind: true,
          matchedTerm: true,
          createdAt: true,
          reviewedAt: true,
          outcome: true,
          reviewedBy: { select: { id: true, fullName: true } },
          message: {
            select: {
              id: true,
              body: true,
              senderId: true,
              createdAt: true,
              deletedForEveryoneAt: true,
              conversationId: true,
              relationId: true,
              relation: {
                select: {
                  id: true,
                  mentor: { select: { id: true, fullName: true } },
                  mentee: { select: { id: true, fullName: true } },
                },
              },
            },
          },
        },
      }),
    ]);

    const senderIds = [...new Set(flags.map((f) => f.message.senderId))];
    const senders = new Map(
      (
        await prisma.user.findMany({
          where: { id: { in: senderIds } },
          select: { id: true, fullName: true, role: true },
        })
      ).map((u) => [u.id, u]),
    );
    const keywords = parseWatchKeywords(await getSetting('safeguardingKeywords', orgId));

    const rows = flags.map((f) => {
      const m = f.message;
      const removed = Boolean(m.deletedForEveryoneAt) || !m.body;
      const sender = senders.get(m.senderId);
      return {
        id: f.id,
        kind: f.kind as Kind,
        matchedTerm: f.matchedTerm,
        createdAt: f.createdAt,
        reviewedAt: f.reviewedAt,
        outcome: f.outcome,
        reviewedBy: f.reviewedBy ? { id: f.reviewedBy.id, name: f.reviewedBy.fullName } : null,
        messageRemoved: removed,
        context: removed ? null : contextFor(m.body, f.kind as Kind, f.matchedTerm, keywords),
        sentAt: m.createdAt,
        sender: sender ? { id: sender.id, name: sender.fullName, role: sender.role } : { id: m.senderId, name: null, role: null },
        relation: m.relation
          ? {
              id: m.relation.id,
              mentor: { id: m.relation.mentor.id, name: m.relation.mentor.fullName },
              mentee: { id: m.relation.mentee.id, name: m.relation.mentee.fullName },
            }
          : null,
        threadLink: m.conversationId ? `/messages/c/${m.conversationId}` : m.relationId ? `/messages/${m.relationId}` : null,
      };
    });

    return NextResponse.json({
      counts: { open, reviewed },
      total,
      page,
      pageSize,
      rows,
    });
  });
}

/**
 * The window of the live body the admin reads. Recomputed rather than stored:
 * the flag keeps only the masked term, so the text itself is never copied out
 * of the message it belongs to.
 */
function contextFor(body: string, kind: Kind, matchedTerm: string, keywords: string[]): string {
  if (kind === 'KEYWORD') {
    const hit = matchWatchKeywords(body, keywords.length ? keywords : [matchedTerm]).find(
      (h) => h.keyword.toLowerCase() === matchedTerm.toLowerCase(),
    ) ?? matchWatchKeywords(body, [matchedTerm])[0];
    if (hit) return hit.context;
  } else {
    const m = detectContactDetails(body).find((c) => maskContact(c.text) === matchedTerm);
    if (m) return contextAround(body, m.start, m.end);
  }
  // The text moved under an edit: show the start of the message instead.
  return contextAround(body, 0, 0, 120);
}
