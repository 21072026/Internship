import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/rateLimit';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { createPasswordResetToken } from '@/lib/passwordReset';
import { sendPasswordResetEmail, sendEmail } from '@/services/emailService';
import { notify } from '@/lib/notify';
import { emailAllowed } from '@/lib/notificationPrefs';
import { emailGroupAllowedForCategory } from '@/lib/emailGroups';
import { dispatchWebhook } from '@/lib/webhooks';
import { checkActiveRelationLimit, planLimitError } from '@/lib/planGate';
import { getMentorAvailability } from '@/lib/mentorAvailability';
import { findPossibleDuplicates } from '@/lib/duplicateDetection';

// The binding capacity rule (#1188): the link is CLOSED when the mentor said
// "not right now" (acceptingMentees=false), or when a set mentorCapacity is
// reached counting active relations PLUS pending applications — otherwise ten
// pending applications against one free seat would all look acceptable. A null
// capacity keeps today's unlimited behavior (existing mentors stay unbroken).
async function mentorApplyState(mentorId: string) {
  const mentor = await prisma.user.findFirst({
    where: { id: mentorId, role: { in: ['MENTOR', 'ADMIN'] }, isActive: true },
  });
  if (!mentor) return null;
  const [active, pending] = await Promise.all([
    prisma.mentorshipRelation.count({ where: { mentorId: mentor.id, status: 'ACTIVE' } }),
    prisma.mentorshipRequest.count({ where: { preferredMentorId: mentor.id, status: 'PENDING' } }),
  ]);
  const availability = getMentorAvailability({
    mentorCapacity: mentor.mentorCapacity,
    activeMenteeCount: active + pending,
    acceptingMentees: mentor.acceptingMentees,
  });
  return { mentor, accepting: availability.status === 'available', reason: availability.status };
}

// GET ?mentorId= — public: validate the link, return the mentor's name so the
// application page can greet the applicant, and say up front whether the link
// is open — a full mentor's link opens an explanation, never an empty form.
export async function GET(request: Request) {
  const mentorId = new URL(request.url).searchParams.get('mentorId') || '';
  const state = await mentorApplyState(mentorId);
  if (!state) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ mentorName: state.mentor.fullName, accepting: state.accepting });
}

const schema = z.object({
  mentorId: z.string().min(1),
  fullName: z.string().min(1),
  email: z.string().email(),
  phone: z.string().optional(),
  city: z.string().optional(),
  university: z.string().optional(),
  department: z.string().optional(),
  skills: z.string().optional(),
});

// POST — public application: creates a mentee linked to the mentor, emails the
// applicant a "set your password" link, and notifies the mentor.
export async function POST(request: Request) {
  const limited = enforceRateLimit(request, 'apply', { limit: 15, windowMs: 10 * 60 * 1000 });
  if (limited) return limited;

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  }
  const { mentorId, fullName, email, phone, city, university, department, skills } = parsed.data;

  const state = await mentorApplyState(mentorId);
  if (!state) return NextResponse.json({ error: 'Invalid application link' }, { status: 404 });
  const mentor = state.mentor;

  // The gate is binding (#1188): a full or paused mentor's link refuses new
  // applications with a clear reason — no silent failure (#679 lesson).
  if (!state.accepting) {
    return NextResponse.json(
      { error: 'This mentor is not taking new applications right now', code: state.reason === 'at_capacity' ? 'mentor_full' : 'mentor_not_accepting' },
      { status: 409 }
    );
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return NextResponse.json({ error: 'An account with this email already exists' }, { status: 409 });
  }

  // Plan gate (#547): an accepted application will create an active relation in
  // the mentor's tenant. Checked here too (before an account is created) so an
  // over-limit org doesn't pile up applications nobody can accept; enforced
  // authoritatively again at accept time by the shared decision service.
  const gate = await checkActiveRelationLimit(mentor.orgId);
  if (!gate.allowed) {
    return NextResponse.json(planLimitError(gate), { status: 403 });
  }

  const mentee = await prisma.user.create({
    data: {
      email,
      password: '!apply-no-login',
      role: 'MENTEE',
      fullName,
      orgId: mentor.orgId,
      emailVerified: false,
      phone: phone || null,
      city: city || null,
      university: university || null,
      department: department || null,
      skills: skills ? skills.split(',').map((s) => s.trim()).filter(Boolean) : [],
    },
  });

  // The application is now a PENDING request the mentor accepts or declines
  // (#1188) — it used to create the ACTIVE relation on the spot, which is
  // exactly the "unbounded commitment" mentors feared. Accepting/rejecting
  // goes through the shared decision service (notification + e-mail to the
  // applicant either way).
  await prisma.mentorshipRequest.create({
    data: { menteeId: mentee.id, preferredMentorId: mentor.id },
  });
  await notify(mentor.id, 'application.received', { name: fullName }, '/mentor/applications');
  await dispatchWebhook('application.created', { mentorId: mentor.id, menteeName: fullName, email });

  // Duplicate post-check (#841): fire-and-forget — the application itself is
  // already accepted, admins just get a heads-up to review /admin/duplicates.
  // Never surfaced in the public response.
  void (async () => {
    const matches = await findPossibleDuplicates({
      orgId: mentor.orgId,
      excludeId: mentee.id,
      fullName,
      email,
      phone,
      university,
    });
    if (matches.length === 0) return;
    const admins = await prisma.user.findMany({ where: { role: 'ADMIN', isActive: true }, select: { id: true } });
    await Promise.all(admins.map((a) => notify(a.id, 'duplicate.suspected', { name: fullName }, '/admin/duplicates')));
  })().catch((e) => console.error('Duplicate post-check failed:', e));

  // Let the applicant set a password so they can sign in to the portal.
  const token = await createPasswordResetToken(mentee.id, 'SET_INITIAL');
  try {
    await sendPasswordResetEmail({ to: mentee.email, token, fullName: mentee.fullName, purpose: 'SET_INITIAL', orgId: mentee.orgId });
  } catch (e) {
    console.error('Applicant set-password email failed:', e);
  }
  // Notify the mentor — honoring their email opt-out (#668: this send used to
  // ignore notificationPrefs entirely, so a mentor with email notifications off
  // still received it).
  if (emailAllowed(mentor, 'mentorship') && emailGroupAllowedForCategory(mentor, 'mentorship-request')) {
    try {
      await sendEmail({
        to: mentor.email,
        subject: `New application: ${fullName}`,
        html: `<div style="font-family: Arial, sans-serif;"><p>${fullName} (${email}) applied to be your mentee.</p></div>`,
        category: 'mentorship-request',
        // The MENTOR is the recipient. The applicant (`mentee`, created a few
        // lines above) is the subject of the mail, and using their id here would
        // both mint the wrong unsubscribe token and let a stranger's public
        // application form switch off a mentor's mail.
        userId: mentor.id,
      });
    } catch (e) {
      console.error('Mentor notification email failed:', e);
    }
  }

  return NextResponse.json({ ok: true });
}
