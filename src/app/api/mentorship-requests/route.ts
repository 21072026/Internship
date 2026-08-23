import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { notify } from '@/lib/notify';
import { emailAllowed } from '@/lib/notificationPrefs';
import { sendMentorshipRequestEmail } from '@/services/emailService';
import { getMenteeRequestGate } from '@/lib/requestGate';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { TEXT_LIMITS } from '@/lib/textLimits';

// Mentee-side mentorship requests (#590): a mentee asks for a mentor; an admin
// approves (creating the MentorshipRelation) or rejects via the admin queue.

const createSchema = z.object({
  message: z.string().max(TEXT_LIMITS.mentorshipRequestMessage).optional(),
  targetPosition: z.string().max(120).optional(),
  // Matching preferences (#939, story #900) — advisory hints for the admin
  // queue; nothing is auto-assigned from them.
  preferredField: z.string().max(120).optional(),
  preferredLanguages: z.array(z.string().min(1).max(32)).max(8).optional(),
  preferredMentorId: z.string().optional(),
});

// GET — the caller's own requests, newest first.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'MENTEE') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  return await withTenantScope(session, async () => {
    const [requests, gate] = await Promise.all([
      prisma.mentorshipRequest.findMany({
        where: { menteeId: session.user.id },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: {
          id: true,
          status: true,
          message: true,
          targetPosition: true,
          preferredField: true,
          preferredLanguages: true,
          preferredMentor: { select: { id: true, fullName: true } },
          createdAt: true,
          decidedAt: true,
        },
      }),
      getMenteeRequestGate(session.user.id),
    ]);
    return NextResponse.json({ requests, gate });
  });
}

// POST — create a request. Guards: one PENDING at a time, no request while a
// mentorship is already active, and a 1h cooldown between submissions (spam).
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'MENTEE') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  return await withTenantScope(session, async () => {
    const parsed = createSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });

    // Onboarding gate (#591) — server-side, never trust the UI: profile + CV
    // must be complete before a request is accepted.
    const gate = await getMenteeRequestGate(session.user.id);
    if (!gate.complete) {
      return NextResponse.json(
        { error: 'Complete your onboarding first', code: 'onboarding_incomplete', missing: gate.missing },
        { status: 400 }
      );
    }

    const [activeRelation, pending, latest] = await Promise.all([
      prisma.mentorshipRelation.findFirst({ where: { menteeId: session.user.id, status: 'ACTIVE' }, select: { id: true } }),
      prisma.mentorshipRequest.findFirst({ where: { menteeId: session.user.id, status: 'PENDING' }, select: { id: true } }),
      prisma.mentorshipRequest.findFirst({ where: { menteeId: session.user.id }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
    ]);
    if (activeRelation) {
      return NextResponse.json({ error: 'You already have an active mentorship', code: 'already_mentored' }, { status: 409 });
    }
    if (pending) {
      return NextResponse.json({ error: 'You already have a pending request', code: 'already_pending' }, { status: 409 });
    }
    if (latest && Date.now() - latest.createdAt.getTime() < 60 * 60 * 1000) {
      return NextResponse.json({ error: 'Please wait before submitting another request', code: 'rate_limited' }, { status: 429 });
    }

    const message = parsed.data.message?.trim() || null;
    const targetPosition = parsed.data.targetPosition?.trim() || null;
    const preferredField = parsed.data.preferredField?.trim() || null;
    const preferredLanguages = (parsed.data.preferredLanguages ?? []).map((l) => l.trim()).filter(Boolean);
    const preferredMentorId = parsed.data.preferredMentorId?.trim() || null;

    // A preferred mentor must be one the mentee can actually see in the
    // directory (#939): active MENTOR with publicProfile AND an active
    // MENTOR_DIRECTORY_VISIBILITY consent — the exact visibility rule of
    // GET /api/mentors (story #900). Anything else is rejected, so a mentee
    // can never point the admin at a mentor who has not opted in.
    if (preferredMentorId) {
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

    const created = await prisma.mentorshipRequest.create({
      data: { menteeId: session.user.id, message, targetPosition, preferredField, preferredLanguages, preferredMentorId },
      select: { id: true, status: true, createdAt: true },
    });

    const menteeName = session.user.name;
    const admins = await prisma.user.findMany({
      where: { role: 'ADMIN', isActive: true },
      select: { id: true, fullName: true, email: true, orgId: true, emailNotifications: true, notificationPrefs: true },
    });
    await Promise.all(
      admins.map((a) =>
        notify(a.id, menteeName ? 'mentorship_request.new' : 'mentorship_request.newGeneric', menteeName ? { from: menteeName } : {}, '/admin/mentorship')
      )
    );

    // Email the admin queue too (#668): a pending request used to be visible only
    // to an admin who happened to log in. Opt-out respected, failures logged.
    // sendMentorshipRequestEmail takes fixed params, so the matching
    // preferences (#939) are appended to its free-text `message` param.
    const preferenceLines = [
      preferredField ? `Preferred field: ${preferredField}` : null,
      preferredLanguages.length ? `Preferred languages: ${preferredLanguages.join(', ')}` : null,
    ].filter((l): l is string => l !== null);
    const emailMessage = [message, ...preferenceLines].filter(Boolean).join('\n') || null;
    for (const a of admins) {
      if (!a.email || !emailAllowed(a, 'mentorship')) continue;
      try {
        await sendMentorshipRequestEmail({
          to: a.email,
          adminName: a.fullName,
          menteeName: menteeName ?? 'a mentee',
          targetPosition,
          message: emailMessage,
          orgId: a.orgId,
        });
      } catch (e) {
        console.error('Mentorship request admin email failed:', e);
      }
    }

    return NextResponse.json({ request: created }, { status: 201 });
  });
}
