import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { enforceRateLimit, rateLimit } from '@/lib/rateLimit';
import { notify } from '@/lib/notify';
import { withTenantScope } from '@/lib/orgContext';
import { TEXT_LIMITS } from '@/lib/textLimits';
import { capSkills } from '@/lib/skills';
import { emailTakenInOrgWorld } from '@/lib/userWorld';
import { sendMentorApplicationReceivedEmail } from '@/services/emailService';
import { orgAdminsWhere } from '@/lib/tenantFilter';
import { resolveRequestVertical } from '@/i18n/server';
import { verticalHasCapability } from '@/lib/verticals';
import type { Prisma } from '@prisma/client';

// Public "become a mentor" applications (#904): anyone can apply without an
// account; an admin reviews the queue (#905/#933). Deliberately does NOT
// create a User — that only happens once an admin approves.

const PAGE_SIZE = 50;
const STATUSES = ['PENDING', 'UNDER_REVIEW', 'APPROVED', 'REJECTED'] as const;

const applySchema = z.object({
  fullName: z.string().min(1).max(191),
  email: z.string().email(),
  phone: z.string().max(191).optional(),
  // A list from the current form, a comma-joined string from an older bundle
  // — `capSkills` splits either (@/lib/skills, #2314).
  expertise: z.union([z.string(), z.array(z.string())]).optional(),
  experience: z.string().max(TEXT_LIMITS.mentorApplicationExperience).optional(),
  motivation: z.string().max(TEXT_LIMITS.mentorApplicationMotivation).optional(),
  capacity: z.number().int().min(1).optional(),
  linkedinUrl: z.string().url().max(TEXT_LIMITS.profileUrl).optional().or(z.literal('')),
  locale: z.enum(['en', 'tr', 'de']).optional(),
  // Anti-spam (mirrors the public-contact form, src/app/api/public-contact/[userId]/route.ts):
  // a hidden honeypot field bots fill in, and a client-stamped render time to
  // reject implausibly fast submits. Accept any value so a filled trap still
  // passes validation — a 400 here would tip bots off.
  website: z.string().max(500).optional(),
  renderedAt: z.number().int().optional(),
});

// POST — public application to become a mentor.
export async function POST(request: Request) {
  const limited = enforceRateLimit(request, 'mentor-application', { limit: 5, windowMs: 15 * 60 * 1000 });
  if (limited) return limited;
  // The form's own gate (requireVerticalCapability on /apply-as-mentor), held
  // on the write too: a direct POST on a product without mentorship would file
  // an application in the internship world and tell its admins about it.
  if (!verticalHasCapability(await resolveRequestVertical(), 'mentorship')) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const parsed = applySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  }
  const { fullName, phone, expertise, experience, motivation, capacity, linkedinUrl, locale, website, renderedAt } = parsed.data;
  // Normalize (trim + lowercase) so a casing/whitespace difference can't dodge
  // the duplicate-pending and existing-account checks below.
  const email = parsed.data.email.trim().toLowerCase();

  // Honeypot filled, or submitted implausibly fast (<3s) → silently accept so
  // bots get no signal, but nothing is created.
  const tooFast = typeof renderedAt === 'number' && Date.now() - renderedAt < 3000;
  if (website || tooFast) return NextResponse.json({ ok: true });

  // Per-email limit in addition to the per-IP one above: an attacker rotating
  // IPs must not be able to hammer one address (mirrors the login brute-force
  // guard keyed by email in src/lib/auth.ts).
  const emailLimited = rateLimit(`mentor-application-email:${email}`, { limit: 5, windowMs: 60 * 60 * 1000 });
  if (!emailLimited.ok) {
    return NextResponse.json(
      { error: 'Too many requests. Please try again later.' },
      { status: 429, headers: { 'Retry-After': String(emailLimited.retryAfter) } }
    );
  }

  // Never reveal whether an account already exists for this email (no user
  // enumeration): silently accept without creating an application or a
  // notification, returning the exact same response as a real submission.
  //
  // "Has an account" is asked in the world this application belongs to (#2590).
  // A public application carries no org of its own — it is filed in the default
  // org, i.e. the INTERNSHIP world (`null` resolves to it, the same rule the
  // approval in [id]/route.ts reads the row back with) — so an address that
  // holds only a MARKETING account is not "already registered" here: that person
  // can still apply, and approval creates their internship mentor account. An
  // address that has an INTERNSHIP account is silently accepted exactly as
  // before (same `{ ok: true }`, nothing created).
  if (await emailTakenInOrgWorld(email, null)) {
    return NextResponse.json({ ok: true });
  }

  const pending = await prisma.mentorApplication.findFirst({
    where: { email, status: 'PENDING' },
    select: { id: true },
  });
  if (pending) {
    return NextResponse.json({ error: 'You already have a pending application' }, { status: 409 });
  }

  await prisma.mentorApplication.create({
    data: {
      fullName,
      email,
      phone: phone || null,
      // Capped rather than refused: an application is not the place to fail
      // over a skills field, and this list becomes `User.skills` on approval.
      expertise: capSkills(expertise),
      experience: experience || null,
      motivation: motivation || null,
      capacity: capacity ?? null,
      linkedinUrl: linkedinUrl || null,
      locale: locale || null,
      consentAt: new Date(),
    },
  });

  // The application is filed org-less, i.e. in the default org (see above), so
  // only that org's admins — the ones whose queue lists it — are told.
  const admins = await prisma.user.findMany({
    where: await orgAdminsWhere(null),
    select: { id: true },
  });
  await Promise.all(
    admins.map((a) =>
      notify(a.id, 'mentor_application.new', { name: fullName }, '/admin/mentor-applications')
    )
  );

  // Best-effort confirmation to the applicant. Not awaited: a slow or
  // misconfigured SMTP connection must not hold this public, unauthenticated
  // endpoint open — a delivery failure (or a delay) must not affect the
  // response at all, unlike the awaited-but-caught admin-invite email
  // (src/app/api/invite/route.ts), which trades responsiveness for reporting
  // send success back to an admin who is watching a spinner.
  void sendMentorApplicationReceivedEmail({ to: email, fullName, locale }).catch((e) => {
    console.error('Mentor application received email failed:', e);
  });

  return NextResponse.json({ ok: true });
}

// GET — admin-only list of applications, filterable by status, paginated.
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  return await withTenantScope(session, async () => {
    const sp = new URL(request.url).searchParams;
    const statusParam = sp.get('status');
    const page = Math.max(1, Number(sp.get('page')) || 1);

    const where: Prisma.MentorApplicationWhereInput = {};
    if (statusParam && (STATUSES as readonly string[]).includes(statusParam)) {
      where.status = statusParam as (typeof STATUSES)[number];
    }

    // Admin-only list: like the detail route, this returns every column, so
    // both `rejectReason` and the private `adminNote` (#1806) reach the review
    // UI and can be shown side by side without a second round trip.
    const [items, total] = await Promise.all([
      prisma.mentorApplication.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
      prisma.mentorApplication.count({ where }),
    ]);

    return NextResponse.json({ items, total, page, pageSize: PAGE_SIZE });
  });
}
