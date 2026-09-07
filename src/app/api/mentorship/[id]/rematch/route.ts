import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { notify } from '@/lib/notify';
import { logActivity } from '@/lib/activity';
import { emailAllowed } from '@/lib/notificationPrefs';
import { emailGroupAllowedForCategory } from '@/lib/emailGroups';
import { sendRematchRequestedEmail } from '@/services/emailService';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { isEndReasonCode } from '@/lib/relationLifecycle';

// Mentee-initiated re-match (#1801): "this pairing isn't working, please match
// me with someone else". Before this route the only way out of a bad match was
// an admin marking the relation COMPLETED, which records a success that never
// happened.
//
// The request travels on the existing MentorshipRequest model with
// `replacesRelationId` set, so the admin queue, the shared decision service and
// the decision e-mails are the ones that already exist — there is no second
// re-match pipeline.
//
// PRIVACY, enforced here and on every read path: `rematchReason` and
// `rematchNote` are for ADMINS ONLY. The outgoing mentor is told the pairing
// ended (on approval) and is never shown either field — a candid reason only
// stays candid if it is not read back by the person it is about.

const rematchSchema = z.object({
  // A code from END_REASON_CODES. z.string() + the whitelist rather than
  // z.enum, so adding a reason never needs a schema change (CLAUDE.md).
  reason: z.string().min(1).max(40),
  note: z.string().max(2000).optional(),
  preferredMentorId: z.string().optional(),
});

/** Same 1h cooldown the sibling POST /api/mentorship-requests applies. */
const COOLDOWN_MS = 60 * 60 * 1000;

/**
 * How long one "new mentor requested" mail speaks for. Inside this window the
 * admins still get an in-app row per request — those are individually
 * meaningful and cost nothing — but only one mail, so a cluster of re-matches
 * (a mentor going quiet, a cohort ending) is a nudge rather than an inbox full
 * of near-identical mails.
 */
const ADMIN_EMAIL_THROTTLE_MS = 15 * 60 * 1000;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  // Only a mentee files this. A mentor who wants out of a pairing goes through
  // the relation's own lifecycle, never on their mentee's behalf.
  if (session.user.role !== 'MENTEE') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  return await withTenantScope(session, async () => {
    const relation = await prisma.mentorshipRelation.findUnique({
      where: { id },
      select: { id: true, menteeId: true, mentorId: true, status: true },
    });
    if (!relation) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (relation.menteeId !== session.user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    if (relation.status !== 'ACTIVE') {
      return NextResponse.json(
        { error: 'The mentorship is not active', code: 'inactive_relation' },
        { status: 409 }
      );
    }

    const body: unknown = await request.json().catch(() => ({}));
    // A re-match with no reason is the one thing the admin queue cannot work
    // with, so an empty or absent code is refused before anything else — its
    // own code, so the form can say "pick a reason" rather than "invalid".
    const rawReason = (body as { reason?: unknown } | null)?.reason;
    if (typeof rawReason !== 'string' || !rawReason.trim()) {
      return NextResponse.json({ error: 'A reason is required', code: 'reason_required' }, { status: 400 });
    }
    const parsed = rematchSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }
    if (!isEndReasonCode(parsed.data.reason)) {
      return NextResponse.json({ error: 'Invalid reason', code: 'invalid_reason' }, { status: 400 });
    }

    const [openRematch, latest] = await Promise.all([
      prisma.mentorshipRequest.findFirst({
        where: { replacesRelationId: relation.id, status: 'PENDING' },
        select: { id: true },
      }),
      prisma.mentorshipRequest.findFirst({
        where: { menteeId: session.user.id },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
    ]);
    // One open re-match per pairing: a queue one person can fill is not a queue.
    if (openRematch) {
      return NextResponse.json(
        { error: 'A re-match request is already pending for this mentorship', code: 'already_pending_rematch' },
        { status: 409 }
      );
    }
    if (latest && Date.now() - latest.createdAt.getTime() < COOLDOWN_MS) {
      return NextResponse.json(
        { error: 'Please wait before submitting another request', code: 'rate_limited' },
        { status: 429 }
      );
    }

    const note = parsed.data.note?.trim() || null;
    const preferredMentorId = parsed.data.preferredMentorId?.trim() || null;

    // The preferred replacement must be a mentor the mentee can actually SEE in
    // the consent-gated directory — the exact visibility rule of GET /api/mentors
    // that POST /api/mentorship-requests already enforces (#939). Naming the
    // current mentor as the replacement is refused too: it is not a re-match.
    if (preferredMentorId) {
      if (preferredMentorId === relation.mentorId) {
        return NextResponse.json({ error: 'invalid_preferred_mentor' }, { status: 400 });
      }
      const preferredMentor = await prisma.user.findFirst({
        where: {
          id: preferredMentorId,
          role: 'MENTOR',
          isActive: true,
          publicProfile: true,
          orgId: resolveOrgId(session),
          consents: { some: { type: 'MENTOR_DIRECTORY_VISIBILITY', grantedAt: { not: null }, revokedAt: null } },
        },
        select: { id: true },
      });
      if (!preferredMentor) {
        return NextResponse.json({ error: 'invalid_preferred_mentor' }, { status: 400 });
      }
    }

    // The old pairing stays LIVE and untouched here, on purpose: cutting a
    // mentee loose before a replacement exists is worse than a bad pairing, and
    // messaging, meetings and the portal must keep working while the admin
    // works the queue. The relation only moves to ENDED_REMATCHED inside the
    // approval transaction (src/lib/mentorshipDecision.ts).
    const created = await prisma.mentorshipRequest.create({
      data: {
        menteeId: session.user.id,
        replacesRelationId: relation.id,
        rematchReason: parsed.data.reason,
        rematchNote: note,
        preferredMentorId,
      },
      select: { id: true, status: true, createdAt: true },
    });

    // Any other re-match inside the window means a mail already went out.
    const recentlyMailed = await prisma.mentorshipRequest.findFirst({
      where: {
        id: { not: created.id },
        replacesRelationId: { not: null },
        createdAt: { gte: new Date(Date.now() - ADMIN_EMAIL_THROTTLE_MS) },
      },
      select: { id: true },
    });

    const menteeName = session.user.name;
    const admins = await prisma.user.findMany({
      where: { role: 'ADMIN', isActive: true },
      select: {
        id: true,
        fullName: true,
        email: true,
        orgId: true,
        preferredLanguage: true,
        emailNotifications: true,
        notificationPrefs: true,
      },
    });
    await Promise.all(
      admins.map((a) =>
        notify(
          a.id,
          menteeName ? 'mentorship_request.rematch' : 'mentorship_request.rematchGeneric',
          menteeName ? { from: menteeName } : {},
          '/admin/mentorship'
        )
      )
    );

    if (!recentlyMailed) {
      for (const a of admins) {
        if (!a.email || !emailAllowed(a, 'mentorship') || !emailGroupAllowedForCategory(a, 'mentorship-request')) continue;
        try {
          // Deliberately carries NO reason and NO note: the mail is a nudge to
          // open the queue, and the fewer places the mentee's words travel the
          // better. Each admin is written to in their own language.
          await sendRematchRequestedEmail({
            to: a.email,
            adminName: a.fullName,
            menteeName: menteeName ?? 'a mentee',
            orgId: a.orgId,
            locale: a.preferredLanguage,
            userId: a.id,
          });
        } catch (e) {
          console.error('Re-match request admin email failed:', e);
        }
      }
    }

    await logActivity({
      action: 'mentorship_request.rematch_requested',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'mentorship_request',
      targetId: created.id,
      // The reason CODE is an operational fact worth auditing; the free-text
      // note is not written here — it belongs to the admin queue only.
      detail: `relation ${relation.id} · reason ${parsed.data.reason}`,
      request,
    });

    return NextResponse.json({ request: created }, { status: 201 });
  });
}
