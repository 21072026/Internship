import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/rateLimit';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { createPasswordResetToken } from '@/lib/passwordReset';
import { sendPasswordResetEmail, sendEmail } from '@/services/emailService';
import { notify } from '@/lib/notify';
import { dispatchWebhook } from '@/lib/webhooks';
import { checkActiveRelationLimit, planLimitError } from '@/lib/planGate';

// GET ?mentorId= — public: validate the link and return the mentor's name so
// the application page can greet the applicant.
export async function GET(request: Request) {
  const mentorId = new URL(request.url).searchParams.get('mentorId') || '';
  const mentor = await prisma.user.findFirst({
    where: { id: mentorId, role: { in: ['MENTOR', 'ADMIN'] }, isActive: true },
    select: { fullName: true },
  });
  if (!mentor) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ mentorName: mentor.fullName });
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

  const mentor = await prisma.user.findFirst({
    where: { id: mentorId, role: { in: ['MENTOR', 'ADMIN'] }, isActive: true },
  });
  if (!mentor) return NextResponse.json({ error: 'Invalid application link' }, { status: 404 });

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return NextResponse.json({ error: 'An account with this email already exists' }, { status: 409 });
  }

  // Plan gate (#547): a public application creates a new active relation in the
  // mentor's tenant. Gate before creating the account. No-op for the unlimited
  // default org.
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

  await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id, orgId: mentor.orgId } });
  await notify(mentor.id, 'application', `${fullName} applied to be your mentee.`, '/mentor/mentees');
  await dispatchWebhook('application.created', { mentorId: mentor.id, menteeName: fullName, email });

  // Let the applicant set a password so they can sign in to the portal.
  const token = await createPasswordResetToken(mentee.id, 'SET_INITIAL');
  try {
    await sendPasswordResetEmail({ to: mentee.email, token, fullName: mentee.fullName, purpose: 'SET_INITIAL' });
  } catch (e) {
    console.error('Applicant set-password email failed:', e);
  }
  // Notify the mentor.
  try {
    await sendEmail({
      to: mentor.email,
      subject: `New application: ${fullName}`,
      html: `<div style="font-family: Arial, sans-serif;"><p>${fullName} (${email}) applied to be your mentee.</p></div>`,
    });
  } catch (e) {
    console.error('Mentor notification email failed:', e);
  }

  return NextResponse.json({ ok: true });
}
