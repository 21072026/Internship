// The caller's own company, for the COMPANY owner's self-serve integration
// routes (#2006): API keys and webhooks. Server-only.
//
// Which company is the caller's is the fail-closed role scope
// (`scopeForRole(…, 'company')`, src/lib/authzScope.ts), never a body field. A
// non-COMPANY session is a 403; a COMPANY session without a company owns
// nothing and gets 403 `company_not_assigned`, logged as a scope denial.
import { NextResponse } from 'next/server';
import type { Session } from 'next-auth';
import { prisma } from '@/lib/prisma';
import { logScopeDenial, scopeForRole } from '@/lib/authzScope';

export async function ownCompany(session: Session, action: string): Promise<{ id: string } | NextResponse> {
  if (session.user.role !== 'COMPANY') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const scope = await scopeForRole(session.user, 'company');
  const company = scope ? await prisma.company.findFirst({ where: scope, select: { id: true } }) : null;
  if (!company) {
    await logScopeDenial(session.user, action);
    return NextResponse.json({ error: 'Company assignment is required', code: 'company_not_assigned' }, { status: 403 });
  }
  return company;
}
