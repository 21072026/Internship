import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { logActivity } from '@/lib/activity';

// Allows only +, digits, spaces, hyphens and parentheses, and requires 7-15 digits.
function isValidPhone(v: string): boolean {
  if (!/^[0-9+\s()-]+$/.test(v)) return false;
  const digitCount = (v.match(/\d/g) || []).length;
  return digitCount >= 7 && digitCount <= 15;
}

// Requires a real calendar date in YYYY-MM-DD format that is today or earlier.
function isValidPastOrTodayDate(v: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!match) return false;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() + 1 !== m || date.getUTCDate() !== d) return false;
  return v <= new Date().toISOString().slice(0, 10);
}

const updateProfileSchema = z.object({
  fullName: z.string().min(1).optional(),
  phone: z.string().optional().refine((v) => !v || isValidPhone(v), 'Invalid phone number'),
  whatsapp: z.string().optional().refine((v) => !v || isValidPhone(v), 'Invalid phone number'),
  city: z.string().optional(),
  birthDate: z.string().optional().refine((v) => !v || isValidPastOrTodayDate(v), 'Birth date must be a valid date and cannot be in the future'),
  referralSource: z.string().optional(),
  university: z.string().optional(),
  department: z.string().optional(),
  graduationYear: z.number().int().nullable().optional(),
  skills: z.array(z.string()).optional(),
  skillLevels: z.record(z.string(), z.number().int().min(1).max(5)).optional(),
  // Full URL or an internal path (/api/cv/<id> set on CV upload).
  cvUrl: z.string().refine((v) => /^https?:\/\//.test(v) || v.startsWith('/'), 'Invalid URL').or(z.literal('')).nullable().optional(),
  publicProfile: z.boolean().optional(),
  // Extended profile fields (EPIC 32).
  displayName: z.string().max(120).optional(),
  bio: z.string().max(2000).optional(),
  country: z.string().max(80).optional(),
  timezone: z.string().max(80).optional(),
  linkedinUrl: z.string().url().or(z.literal('')).optional(),
  githubUrl: z.string().url().or(z.literal('')).optional(),
  portfolioUrl: z.string().url().or(z.literal('')).optional(),
  interests: z.string().max(2000).optional(),
  targetPosition: z.string().max(160).optional(),
  mentorCapacity: z.number().int().min(0).max(100).nullable().optional(),
  emailNotifications: z.boolean().optional(),
  notificationPrefs: z.record(z.string(), z.boolean()).optional(),
  preferredLanguage: z.enum(['en', 'tr', 'de']).optional(),
  theme: z.enum(['light', 'dark', 'system']).optional(),
});

// Profile fields surfaced by both GET and PUT responses.
const PROFILE_SELECT = {
  id: true,
  email: true,
  fullName: true,
  role: true,
  phone: true,
  whatsapp: true,
  city: true,
  birthDate: true,
  referralSource: true,
  university: true,
  department: true,
  graduationYear: true,
  skills: true,
  skillLevels: true,
  cvUrl: true,
  avatarUrl: true,
  publicProfile: true,
  profileViews: true,
  displayName: true,
  bio: true,
  country: true,
  timezone: true,
  linkedinUrl: true,
  githubUrl: true,
  portfolioUrl: true,
  interests: true,
  targetPosition: true,
  mentorCapacity: true,
  emailNotifications: true,
  notificationPrefs: true,
  preferredLanguage: true,
  theme: true,
  createdAt: true,
} as const;

export async function GET() {
  try {
    const session = await getServerSession(authOptions);

    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: PROFILE_SELECT,
    });

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    return NextResponse.json({ user });
  } catch (error) {
    console.error('Get profile error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const session = await getServerSession(authOptions);

    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const parsed = updateProfileSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { cvUrl, birthDate, ...rest } = parsed.data;

    const user = await prisma.user.update({
      where: { id: session.user.id },
      data: {
        ...rest,
        ...(cvUrl !== undefined ? { cvUrl: cvUrl || null } : {}),
        ...(birthDate !== undefined
          ? { birthDate: birthDate ? new Date(birthDate) : null }
          : {}),
      },
      select: PROFILE_SELECT,
    });

    await logActivity({ action: 'profile.update', actorId: session.user.id, actorEmail: session.user.email ?? null });
    return NextResponse.json({ user });
  } catch (error) {
    console.error('Update profile error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
