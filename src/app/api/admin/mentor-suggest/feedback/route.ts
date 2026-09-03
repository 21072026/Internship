import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import {
  MATCH_REASON_NOTE_MAX,
  isMatchDismissReason,
  isMatchFeedbackOutcome,
} from '@/lib/matchFeedback';

// Whitelist validation rather than z.enum, the way the rest of this repo
// validates codes (CLAUDE.md) — the list lives in one client-safe module that
// the picker and this route both read.
const schema = z.object({
  batchId: z.string().min(1),
  mentorId: z.string().min(1),
  action: z.string().refine(isMatchFeedbackOutcome),
  reason: z.string().refine(isMatchDismissReason).optional(),
  reasonNote: z.string().trim().max(MATCH_REASON_NOTE_MAX).optional(),
});

// POST — what the admin did with one suggestion from a batch (#2040).
//
// ACCEPTED  the admin assigned this mentor.
// DISMISSED the admin threw this suggestion away, with a short reason.
//
// Two cases the report depends on being distinguishable:
//   * the mentor WAS in the batch  → the SHOWN row is upgraded in place, so the
//     rank it was shown at is preserved and "does our #1 get picked?" is
//     answerable;
//   * the mentor was NOT in the batch (the admin ignored us and picked someone
//     else) → a fresh row with rank = NULL. That is the whole signal: a null
//     rank means "we did not suggest this person", and the per-rank report
//     counts only rows that have a rank.
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  // Authorization at the route, never by hiding the control.
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  return await withTenantScope(session, async () => {
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    const { batchId, mentorId, action, reasonNote } = parsed.data;

    // A dismissal without a reason is the one thing this table exists to
    // capture; refuse it rather than store an unattributable row.
    if (action === 'DISMISSED' && !parsed.data.reason) {
      return NextResponse.json({ error: 'Reason required' }, { status: 400 });
    }
    const reason = action === 'DISMISSED' ? parsed.data.reason ?? null : null;

    // The batch anchors the write: it names the mentee, the rule set and
    // whether AI ranked it. No batch, nothing to attach an outcome to.
    const batch = await prisma.matchFeedback.findMany({
      where: { batchId },
      select: { mentorId: true, menteeId: true, aiUsed: true, ruleSetVersion: true, rank: true },
    });
    if (batch.length === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const shown = batch.find((r) => r.mentorId === mentorId) ?? null;
    // Dismissing something that was never shown is not a decision about a
    // suggestion — reject it rather than invent a rank-less DISMISSED row.
    if (!shown && action === 'DISMISSED') {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    await prisma.matchFeedback.upsert({
      where: { batchId_mentorId: { batchId, mentorId } },
      update: {
        action,
        reason,
        reasonNote: reasonNote || null,
        actorId: session.user.id,
      },
      create: {
        orgId: resolveOrgId(session),
        menteeId: batch[0].menteeId,
        mentorId,
        batchId,
        // Off-list assignment: we never ranked this mentor in this batch.
        rank: null,
        score: null,
        ruleSetVersion: batch[0].ruleSetVersion,
        aiUsed: batch[0].aiUsed,
        action,
        reason,
        reasonNote: reasonNote || null,
        actorId: session.user.id,
      },
    });

    return NextResponse.json({ ok: true, action, rank: shown?.rank ?? null, suggested: !!shown });
  });
}
