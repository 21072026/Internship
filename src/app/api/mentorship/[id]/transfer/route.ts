import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { withTenantScope } from '@/lib/orgContext';
import { transferMentorship } from '@/lib/mentorTransfer';
import { isAdminEndReasonCode, REASON_NOTE_REQUIRED_FOR } from '@/lib/relationLifecycle';

// POST /api/mentorship/<id>/transfer — change this mentee's mentor (#2289).
//
// ONE request, one transaction. The alternative an admin had until now was two
// unlinked ones (close, then assign), which records a completion that never
// happened and, between the two, either two live mentors or none.
//
// ADMIN only. A mentor may not hand their own mentee to somebody else: the
// receiving mentor never agreed, the outgoing one would be deciding another
// person's caseload, and #1801 already settled the mirror case (a mentor-facing
// caller cannot decide a re-match either). A mentee who wants a different
// mentor files a re-match instead — POST /api/mentorship/<id>/rematch — which
// goes through the admin queue.
//
// The behaviour, the two modes and the history rule all live in
// src/lib/mentorTransfer.ts; this handler is authorization plus validation.

const transferSchema = z.object({
  toMentorId: z.string().min(1),
  // A code from ADMIN_END_REASON_CODES. z.string() + the whitelist rather than
  // z.enum, so adding a reason never needs a schema change (CLAUDE.md), and
  // the same shape the re-match route validates with.
  reasonCode: z.string().min(1).max(40),
  reasonNote: z.string().max(2000).optional(),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    return await withTenantScope(session, async () => {
      const body: unknown = await request.json().catch(() => ({}));
      const parsed = transferSchema.safeParse(body);
      if (!parsed.success) {
        return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
      }
      // Each refusal carries its own code so the dialog can say which field is
      // wrong instead of one generic line — the #2283 lesson: a refusal the
      // admin cannot act on is how people learn to fake a completion.
      if (!isAdminEndReasonCode(parsed.data.reasonCode)) {
        return NextResponse.json({ error: 'Invalid reason', code: 'invalid_reason' }, { status: 400 });
      }
      const note = parsed.data.reasonNote?.trim() || null;
      if (parsed.data.reasonCode === REASON_NOTE_REQUIRED_FOR && !note) {
        return NextResponse.json({ error: 'A note is required', code: 'note_required' }, { status: 400 });
      }

      const result = await transferMentorship({
        relationId: id,
        toMentorId: parsed.data.toMentorId,
        reasonCode: parsed.data.reasonCode,
        reasonNote: note,
        actorId: session.user.id,
        actorEmail: session.user.email ?? null,
        request,
      });
      return NextResponse.json(result.body, { status: result.status });
    });
  } catch (error) {
    console.error('Mentor transfer error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
