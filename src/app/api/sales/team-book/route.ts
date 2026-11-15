import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { withRequestScope } from '@/lib/requestContext';
import { withTenantScope } from '@/lib/orgContext';
import { loadSalesTeamBook, parseSalesTeamBookQuery } from '@/lib/salesTeamBook';

// GET ?owners=<id,id>&stage=<KEY>&status=active|all — the team's sales book,
// read-only (src/lib/salesTeamBook.ts; the rule: src/lib/salesBookRule.ts).
// 401 without a session; 404 for whoever may not read it (no sales surface, a
// rep while `salesTeamBookForReps` is off, MENTEE/COMPANY) — the same answer as
// a route that does not exist, so it confirms nothing. Never a write.
export async function GET(request: Request) {
  return withRequestScope(request, async () => {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    return withTenantScope(session, async () => {
      const book = await loadSalesTeamBook(session, parseSalesTeamBookQuery(new URL(request.url).searchParams));
      if (!book) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      return NextResponse.json(book);
    });
  });
}
