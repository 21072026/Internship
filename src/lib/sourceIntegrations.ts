// The caller's own source, for the SOURCE owner's self-serve integration
// routes (#2006): API keys. Server-only. The twin of ownCompany()
// (src/lib/companyIntegrations.ts).
//
// Which source is the caller's is the fail-closed role scope helper
// (`sourceIdForUser`, src/lib/authzScope.ts — the one `/api/source/mentees`
// and the relation scope use), never a body field. A non-SOURCE session is a
// 403; a SOURCE session without a source owns nothing and gets 403
// `source_not_assigned`, logged as a scope denial.
import { NextResponse } from 'next/server';
import type { Session } from 'next-auth';
import { prisma } from '@/lib/prisma';
import { logScopeDenial, sourceIdForUser } from '@/lib/authzScope';
import { resolveOrgId } from '@/lib/orgScope';

export async function ownSource(session: Session, action: string): Promise<{ id: string } | NextResponse> {
  if (session.user.role !== 'SOURCE') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const sourceId = await sourceIdForUser(session.user.id);
  const source = sourceId ? await prisma.source.findFirst({ where: { id: sourceId, orgId: resolveOrgId(session) }, select: { id: true } }) : null;
  if (!source) {
    await logScopeDenial(session.user, action);
    return NextResponse.json({ error: 'Source assignment is required', code: 'source_not_assigned' }, { status: 403 });
  }
  return source;
}
