import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { withRequestScope } from '@/lib/requestContext';
import { withTenantScope } from '@/lib/orgContext';
import { salesPoolGate } from '@/lib/salesPoolGate';
import { addLeadNote } from '@/lib/leadNotes';

// POST { text } — a free note on a sales record (#3978, src/lib/leadNoteRule.ts).
// Whoever may work the record, or owned it before and handed it on; anyone else
// gets the same 404 as an id that does not exist. A colleague's note rings the
// owner (in-app and e-mail). Never a contact, never a write to the record.
const schema = z.object({ text: z.string().max(2000) });

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
      const outcome = await addLeadNote({ session, orgId: g.orgId, relationId: id, text: parsed.data.text });
      if (!outcome.ok) {
        return NextResponse.json({ error: outcome.code === 'missing' ? 'Not found' : 'Invalid note', code: outcome.code }, { status: outcome.status });
      }
      return NextResponse.json({ ok: true, notified: outcome.notified }, { status: 201 });
    });
  });
}
