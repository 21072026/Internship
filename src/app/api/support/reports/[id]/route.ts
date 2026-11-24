import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { withRequestScope } from '@/lib/requestContext';
import { withTenantScope } from '@/lib/orgContext';
import { myFeedbackReport } from '@/lib/myFeedbackReports';

// One of the caller's own reports (#3877). Another person's — or another org's —
// id is 404, the same answer as an id that does not exist.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withRequestScope(request, async () => {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const { id } = await params;
    return withTenantScope(session, async () => {
      const report = await myFeedbackReport(session, id);
      if (!report) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      return NextResponse.json({ report });
    });
  });
}
