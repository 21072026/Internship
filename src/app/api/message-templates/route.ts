import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { serializeMessageTemplate } from '@/lib/messageTemplates';

// The canned responses one writer is offered (#1871) — read-only.
//
// "Available to me" is the org-wide pool plus my own personal templates, never
// somebody else's: `ownerId: null` OR `ownerId: me`. Anything archived is gone
// from the picker but still in the table (see the admin DELETE handler).
//
// Free core: messaging and its conveniences are free, always — no plan gate here.

// GET — my pickable pool, most-used first so the replies actually used are the
// ones at the top of the list.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  return await withTenantScope(session, async () => {
    const templates = await prisma.messageTemplate.findMany({
      where: {
        archivedAt: null,
        OR: [{ ownerId: null }, { ownerId: session.user.id }],
      },
      orderBy: [{ useCount: 'desc' }, { createdAt: 'asc' }],
      select: { id: true, title: true, translations: true, useCount: true, ownerId: true },
    });
    return NextResponse.json({ templates: templates.map(serializeMessageTemplate) });
  });
}
