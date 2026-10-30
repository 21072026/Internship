// The daily mentorship-request sweep (#1775) — the ONLY writer of a request's
// expiry state (`nudgeSentAt`, and the PENDING → EXPIRED move). The rule is
// src/lib/requestExpiryRule.ts; this file applies it.
//
// Every write is a guarded `updateMany` on the state it read: a request an
// admin decided (or a mentee withdrew a moment ago) is not expired over the
// top of that decision, and two overlapping runs cannot both nudge — the one
// whose update hit 0 rows sends nothing. A rerun of the sweep therefore finds
// nothing new (at-least-once safe, the job queue's contract).
//
// Notifications are in-app (`notify`), like every other step of the request
// lifecycle; the nudge is ONE per request, ever.
import { prisma } from '@/lib/prisma';
import { notify } from '@/lib/notify';
import { defaultOrgId } from '@/lib/defaultOrg';
import { REQUEST_NUDGE_AFTER_DAYS, expiryAction } from '@/lib/requestExpiryRule';

const DAY = 24 * 60 * 60 * 1000;
const BATCH = 500;

export interface RequestSweepResult {
  expired: number;
  nudged: number;
}

export async function sweepMentorshipRequests(now: Date = new Date()): Promise<RequestSweepResult> {
  const result: RequestSweepResult = { expired: 0, nudged: 0 };
  // Nothing younger than the nudge age can need either action.
  const due = await prisma.mentorshipRequest.findMany({
    where: { status: 'PENDING', createdAt: { lte: new Date(now.getTime() - REQUEST_NUDGE_AFTER_DAYS * DAY) } },
    select: {
      id: true,
      status: true,
      createdAt: true,
      expiresAt: true,
      nudgeSentAt: true,
      menteeId: true,
      preferredMentorId: true,
      replacesRelationId: true,
      preferredMentor: { select: { id: true, isActive: true, role: true } },
      mentee: { select: { fullName: true, orgId: true } },
    },
    orderBy: { createdAt: 'asc' },
    take: BATCH,
  });

  let fallbackOrg: string | null | undefined;
  for (const req of due) {
    const action = expiryAction(req, now);
    if (action === 'expire') {
      const moved = await prisma.mentorshipRequest.updateMany({
        where: { id: req.id, status: 'PENDING' },
        data: { status: 'EXPIRED' },
      });
      if (moved.count === 1) {
        result.expired++;
        await notify(req.menteeId, 'mentorship_request.expired', {}, '/portal');
      }
    } else if (action === 'nudge') {
      const claimed = await prisma.mentorshipRequest.updateMany({
        where: { id: req.id, status: 'PENDING', nudgeSentAt: null },
        data: { nudgeSentAt: now },
      });
      if (claimed.count !== 1) continue;
      result.nudged++;
      // The named mentor holds it — unless it is a re-match, which only an
      // admin may decide (#1801), or the mentor is gone; then the org's admins.
      const mentor = req.preferredMentor;
      let recipients: string[];
      if (mentor && mentor.isActive && mentor.role === 'MENTOR' && !req.replacesRelationId) {
        recipients = [mentor.id];
      } else {
        if (req.mentee.orgId == null && fallbackOrg === undefined) fallbackOrg = await defaultOrgId();
        const orgId = req.mentee.orgId ?? fallbackOrg ?? null;
        recipients = (
          await prisma.user.findMany({ where: { role: 'ADMIN', isActive: true, orgId }, select: { id: true } })
        ).map((u) => u.id);
      }
      for (const userId of recipients) {
        await notify(userId, 'mentorship_request.nudge', { from: req.mentee.fullName }, mentor && recipients[0] === mentor.id ? '/mentor/applications' : '/admin/mentorship');
      }
    }
  }
  return result;
}
