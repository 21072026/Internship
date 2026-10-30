import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { requireRoleOrPermission } from '@/lib/authz';
import { withTenantScope } from '@/lib/orgContext';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { logActivity } from '@/lib/activity';
import { raiseLifecycleChanged } from '@/lib/lifecycleEvents';
import { notify } from '@/lib/notify';
import { AlreadyMentoredError, ALREADY_MENTORED_ERROR, findActiveMentorship } from '@/lib/activeMentorship';
import {
  ACTIVE,
  PAUSED,
  checkLifecycleMove,
  effectiveLifecycleState,
  isTerminal,
  lifecycleNotificationType,
  stageClockPatch,
  statusForLifecycle,
} from '@/lib/relationLifecycle';

// POST /api/mentorship/<id>/lifecycle — the ONE writer of a pairing's lifecycle
// state (#1770): pause, resume, end with a reason, or (admin) reopen.
//
// Who may make which move, and which reason an end needs, is
// checkLifecycleMove() in src/lib/relationLifecycle.ts — this handler is
// authentication, the tenant lookup and the write. `status` is never read from
// the body: it is derived with statusForLifecycle(), so it cannot disagree with
// the state. The move and its RelationLifecycleEvent row are one transaction,
// guarded on the state the check was made against — a concurrent move answers
// 409 instead of writing twice.
//
// The re-match, transfer and win-back flows keep their own endpoints: each ends
// a pairing AND creates its successor, which this endpoint never does.

const lifecycleSchema = z.object({
  to: z.string().min(1).max(40),
  // Codes from LIFECYCLE_END_REASON_CODES — z.string() + the whitelist, never z.enum.
  reasonCode: z.string().max(40).optional(),
  reasonNote: z.string().max(2000).optional(),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    // Only staff move a pairing; a mentee's way out is the re-match request (#1801).
    const gate = await requireRoleOrPermission(['MENTOR'], 'relation.write', { request });
    if ('error' in gate) return gate.error;
    const { session, admin } = gate;

    return await withTenantScope(session, async () => {
      const relation = await prisma.mentorshipRelation.findFirst({
        where: withinTenant({ id }, await tenantWhere(session)),
        select: {
          id: true,
          orgId: true,
          status: true,
          lifecycleState: true,
          stageDeadline: true,
          stageDeadlineRemainingDays: true,
          mentorId: true,
          menteeId: true,
          mentor: { select: { fullName: true } },
          mentee: { select: { fullName: true } },
        },
      });
      const isOwnMentor = relation?.mentorId === session.user.id;
      // Not yours = 404, the same answer as another tenant's id: a 403 would
      // confirm the pairing exists.
      if (!relation || (!admin && !isOwnMentor)) {
        return NextResponse.json({ error: 'Relation not found' }, { status: 404 });
      }

      const body: unknown = await request.json().catch(() => ({}));
      const parsed = lifecycleSchema.safeParse(body);
      if (!parsed.success) {
        return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
      }
      const reasonNote = parsed.data.reasonNote?.trim() || null;
      const check = checkLifecycleMove({
        role: session.user.role,
        isOwnMentor,
        relation,
        to: parsed.data.to,
        reasonCode: parsed.data.reasonCode ?? null,
        reasonNote,
      });
      if (!check.ok) {
        const { ok: _ok, status, ...rest } = check;
        return NextResponse.json({ error: 'Lifecycle move refused', ...rest }, { status });
      }
      const { from, to } = check;
      const ending = isTerminal(to);
      const reopening = to === ACTIVE && isTerminal(from);
      const reasonCode = ending ? parsed.data.reasonCode! : null;
      const now = new Date();

      try {
        await prisma.$transaction(async (tx) => {
          // A reopen is a second assignment by another name (#419): it owes
          // the same 409 every other assignment path answers.
          if (reopening) {
            const active = await findActiveMentorship(tx, relation.menteeId, { exceptRelationId: id });
            if (active) throw new AlreadyMentoredError(relation.menteeId, active.id);
          }
          const moved = await tx.mentorshipRelation.updateMany({
            // Guarded on the row the check read: a move made in between wins,
            // and this one answers 409 rather than stacking a second event.
            where: { id, status: relation.status, lifecycleState: relation.lifecycleState },
            data: {
              lifecycleState: to,
              status: statusForLifecycle(to),
              pausedAt: to === PAUSED ? now : null,
              // The stage clock freezes with the pair and the dormancy episode
              // ends on resume (#1772) — one rule, stageClockPatch().
              ...stageClockPatch(from, to, relation, now),
              // completedAt anchors the post-mentorship document window (#854):
              // stamped on every end, cleared on a reopen, untouched by pause/resume.
              ...(ending ? { completedAt: now, endReasonCode: reasonCode } : {}),
              ...(reopening ? { completedAt: null, endReasonCode: null } : {}),
            },
          });
          if (moved.count !== 1) throw new LifecycleConflict();
          await tx.relationLifecycleEvent.create({
            data: {
              relationId: id,
              fromState: from,
              toState: to,
              reasonCode,
              reasonNote,
              changedById: session.user.id,
            },
          });
        });
      } catch (e) {
        if (e instanceof AlreadyMentoredError) return NextResponse.json(ALREADY_MENTORED_ERROR, { status: 409 });
        if (e instanceof LifecycleConflict) {
          return NextResponse.json({ error: 'The pairing changed meanwhile', code: 'lifecycle_conflict' }, { status: 409 });
        }
        throw e;
      }

      await raiseLifecycleChanged({ relationId: id, orgId: relation.orgId, from, to, reasonCode, actorId: session.user.id });

      // Both participants hear about it, by name of the other one — never the
      // reason, which is the actor's note. No echo to whoever made the move.
      const type = lifecycleNotificationType(from, to);
      if (relation.mentorId !== session.user.id) {
        await notify(relation.mentorId, type, { name: relation.mentee.fullName }, '/mentor');
      }
      if (relation.menteeId !== session.user.id) {
        await notify(relation.menteeId, type, { name: relation.mentor.fullName }, '/portal');
      }
      await logActivity({
        action: 'relation.lifecycle_change',
        actorId: session.user.id,
        actorEmail: session.user.email ?? null,
        targetType: 'relation',
        targetId: id,
        detail: `${from} → ${to}` + (reasonCode ? ` · reason ${reasonCode}` : ''),
        request,
      });

      return NextResponse.json({ ok: true, from, to, status: statusForLifecycle(to) });
    });
  } catch (error) {
    console.error('Relation lifecycle error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

class LifecycleConflict extends Error {}

// GET — the pairing's lifecycle history, newest first. The same audience as the
// moves: an admin of the tenant and the relation's own mentor. Not the mentee —
// the notes are the staff's own words about them (#1801's rule).
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const gate = await requireRoleOrPermission(['MENTOR'], 'program.read', { request: _request });
    if ('error' in gate) return gate.error;
    const { session, admin } = gate;
    return await withTenantScope(session, async () => {
      const relation = await prisma.mentorshipRelation.findFirst({
        where: withinTenant({ id }, await tenantWhere(session)),
        select: { id: true, status: true, lifecycleState: true, pausedAt: true, endReasonCode: true, mentorId: true },
      });
      if (!relation || (!admin && relation.mentorId !== session.user.id)) {
        return NextResponse.json({ error: 'Relation not found' }, { status: 404 });
      }
      const events = await prisma.relationLifecycleEvent.findMany({
        where: { relationId: id },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: {
          id: true,
          fromState: true,
          toState: true,
          reasonCode: true,
          reasonNote: true,
          createdAt: true,
          changedBy: { select: { fullName: true } },
        },
      });
      return NextResponse.json({
        state: effectiveLifecycleState(relation),
        pausedAt: relation.pausedAt,
        endReasonCode: relation.endReasonCode,
        events: events.map(({ changedBy, ...e }) => ({ ...e, changedByName: changedBy.fullName })),
      });
    });
  } catch (error) {
    console.error('Relation lifecycle history error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
