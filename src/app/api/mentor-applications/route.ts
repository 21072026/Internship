import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { enforceRateLimit, rateLimit } from '@/lib/rateLimit';
import { notify } from '@/lib/notify';
import { withTenantScope } from '@/lib/orgContext';
import { TEXT_LIMITS } from '@/lib/textLimits';
import type { Prisma } from '@prisma/client';

// Public "become a mentor" applications (#904): anyone can apply without an
// account; an admin reviews the queue. Deliberately does NOT create a User —
// turning an approved application into an account is a later task.

const PAGE_SIZE = 50;
const STATUSES = ['PENDING', 'APPROVED', 'REJECTED'] as const;

const applySchema = z.object({
  fullName: z.string().min(1).max(191),
  email: z.string().email(),
  phone: z.string().max(191).optional(),
  expertise: z.string().optional(),
  experience: z.string().max(TEXT_LIMITS.mentorApplicationExperience).optional(),
  motivation: z.string().max(TEXT_LIMITS.mentorApplicationMotivation).optional(),
  capacity: z.number().int().min(1).optional(),
  linkedinUrl: z.string().url().max(500).optional().or(z.literal('')),
  locale: z.enum(['en', 'tr', 'de']).optional(),
});

// POST — public application to become a mentor.
export async function POST(request: Request) {
  const limited = enforceRateLimit(request, 'mentor-application', { limit: 5, windowMs: 15 * 60 * 1000 });
  if (limited) return limited;

  const parsed = applySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  }
  const { fullName, phone, expertise, experience, motivation, capacity, linkedinUrl, locale } = parsed.data;
  // Normalize (trim + lowercase) so a casing/whitespace difference can't dodge
  // the duplicate-pending and existing-account checks below.
  const email = parsed.data.email.trim().toLowerCase();

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
  const existingUser = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existingUser) {
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
      expertise: expertise ? expertise.split(',').map((s) => s.trim()).filter(Boolean) : [],
      experience: experience || null,
      motivation: motivation || null,
      capacity: capacity ?? null,
      linkedinUrl: linkedinUrl || null,
      locale: locale || null,
      consentAt: new Date(),
    },
  });

  const admins = await prisma.user.findMany({
    where: { role: 'ADMIN', isActive: true },
    select: { id: true },
  });
  await Promise.all(
    admins.map((a) =>
      notify(a.id, 'mentor_application', `${fullName} applied to become a mentor.`, '/admin/mentor-applications')
    )
  );

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
