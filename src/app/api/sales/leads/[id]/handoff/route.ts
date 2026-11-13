import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { withRequestScope } from '@/lib/requestContext';
import { withTenantScope } from '@/lib/orgContext';
import { salesPoolGate } from '@/lib/salesPoolGate';
import { handOffLead } from '@/lib/leadHandoff';
import { HANDOFF_ACTIONS, HANDOFF_NOTE_MAX } from '@/lib/leadHandoffRule';

// Hand a lead to a colleague with its next step (the board's rep strip). The
// owner may hand off their own record; an admin any record of the org. The
// ownership change is the transfer operation, the step is the record's
// follow-up — src/lib/leadHandoffRule.ts says why it is exactly those two.
const schema = z.object({
  toUserId: z.string().min(1).max(64),
  action: z.enum(HANDOFF_ACTIONS),
  note: z.string().max(HANDOFF_NOTE_MAX).nullable().optional(),
  dueOn: z.string().max(10).nullable().optional(),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withRequestScope(request, async () => {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const g = await salesPoolGate(session);
    if (!g.ok) return g.response;
    const { id } = await params;
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed', code: 'invalid_body' }, { status: 400 });
    return withTenantScope(session, async () => {
      const outcome = await handOffLead({ session, orgId: g.orgId, relationId: id, ...parsed.data, request });
      if (!outcome.ok) return NextResponse.json({ error: 'Hand-off refused', code: outcome.code }, { status: outcome.status });
      return NextResponse.json({ relationId: outcome.relationId, mode: outcome.mode, toName: outcome.toName });
    });
  });
}
