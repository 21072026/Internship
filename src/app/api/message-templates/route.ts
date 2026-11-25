import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { serializeMessageTemplate, templateChannel } from '@/lib/messageTemplates';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';

// The canned responses one writer is offered (#1871) — read-only.
//
// "Available to me" is the org-wide pool plus my own personal templates, never
// somebody else's: `ownerId: null` OR `ownerId: me`. Anything archived is gone
// from the picker but still in the table (see the admin DELETE handler).
// The org-wide pool is the caller's OWN org's (cross-world isolation).
//
// Free core: messaging and its conveniences are free, always — no plan gate here.

// GET — my pickable pool, most-used first so the replies actually used are the
// ones at the top of the list. `?channel=email` is the lead e-mail picker's
// pool (#3908); without it, the composer's canned replies, as always.
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  return await withTenantScope(session, async () => {
    const templates = await prisma.messageTemplate.findMany({
      where: withinTenant(
        {
          archivedAt: null,
          channel: templateChannel(new URL(request.url).searchParams.get('channel')),
          OR: [{ ownerId: null }, { ownerId: session.user.id }],
        },
        await tenantWhere(session)
      ),
      orderBy: [{ useCount: 'desc' }, { createdAt: 'asc' }],
      select: { id: true, title: true, translations: true, useCount: true, ownerId: true, channel: true, subjects: true },
    });
    return NextResponse.json({ templates: templates.map(serializeMessageTemplate) });
  });
}
