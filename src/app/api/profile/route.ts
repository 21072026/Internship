import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { logActivity } from '@/lib/activity';
import { withTenantScope } from '@/lib/orgContext';
import { getMentorAvailability } from '@/lib/mentorAvailability';

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
  languages: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
  skillLevels: z.record(z.string(), z.number().int().min(1).max(5)).optional(),
  // Full URL or an internal path (/api/cv/<id> set on CV upload).
  cvUrl: z.string().refine((v) => /^https?:\/\//.test(v) || v.startsWith('/'), 'Invalid URL').or(z.literal('')).nullable().optional(),
  publicProfile: z.boolean().optional(),
  // Public-profile project showcase toggle (#1091) — the section rides
  // publicProfile; this lets the user turn just that section off.
  publicShowProjects: z.boolean().optional(),
  // Extended profile fields (EPIC 32).
  displayName: z.string().max(120).optional(),
  bio: z.string().max(2000).optional(),
  country: z.string().max(80).optional(),
  timezone: z.string().max(80).optional().refine(
    (tz) => {
      if (!tz) return true;
      try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; }
      catch { return false; }
    },
    { message: 'Invalid IANA timezone' }
  ),
  linkedinUrl: z.string().url().or(z.literal('')).optional(),
  githubUrl: z.string().url().or(z.literal('')).optional(),
  portfolioUrl: z.string().url().or(z.literal('')).optional(),
  interests: z.string().max(2000).optional(),
  targetPosition: z.string().max(160).optional(),
  mentorCapacity: z.number().int().min(0).max(100).nullable().optional(),
  // Name display on a published testimonial (#1096): full name is an explicit
  // choice; null/unset renders initials (the privacy-first default).
  testimonialNameStyle: z.enum(['fullname', 'initials']).nullable().optional(),
  // Mentor's own "I can take a new mentee right now" preference (#941) — see
  // src/lib/mentorAvailability.ts for how this combines with mentorCapacity.
  // null clears the preference (falls back to a capacity-derived guess).
  acceptingMentees: z.boolean().nullable().optional(),
  emailNotifications: z.boolean().optional(),
  notificationPrefs: z.record(z.string(), z.boolean()).optional(),
  preferredLanguage: z.enum(['en', 'tr', 'de']).optional(),
  theme: z.enum(['light', 'dark', 'system']).optional(),
  fontSize: z.enum(['sm', 'md', 'lg', 'xl']).optional(),
  accentColor: z.enum(['blue', 'green', 'purple', 'rose', 'teal', 'amber']).optional(),
});

const PROFILE_FIELDS = new Set(Object.keys(updateProfileSchema.shape));
const MENTEE_ONLY_FIELDS = new Set(['university', 'department', 'graduationYear', 'targetPosition', 'cvUrl']);
// `interests` is deliberately absent: both roles fill it in (a mentee's areas of
// interest, a mentor's areas of expertise), so it is not owned by either.
const MENTOR_ONLY_FIELDS = new Set(['mentorCapacity', 'acceptingMentees', 'languages']);

function forbiddenProfileFields(body: unknown, role: string): string[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  return Object.keys(body).filter((field) => {
    if (!PROFILE_FIELDS.has(field)) return true;
    if (role === 'MENTOR' && MENTEE_ONLY_FIELDS.has(field)) return true;
    if (role === 'MENTEE' && MENTOR_ONLY_FIELDS.has(field)) return true;
    return false;
  });
}

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
  languages: true,
  skillLevels: true,
  cvUrl: true,
  avatarUrl: true,
  publicProfile: true,
  publicShowProjects: true,
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
  acceptingMentees: true,
  testimonialNameStyle: true,
  emailNotifications: true,
  notificationPrefs: true,
  preferredLanguage: true,
  theme: true,
  fontSize: true,
  accentColor: true,
  createdAt: true,
} as const;

// ── Auditing a notification change made on /account ────────────────────────
//
// The three unsubscribe token routes each write an `email.unsubscribe` /
// `email.resubscribe` ActivityLog row, but a switch flipped on /account comes
// through here instead, and this endpoint only ever logged a bare
// 'profile.update'. That left "I stopped getting the weekly digest around
// August" unanswerable: the scheduled jobs guard at the call site, so a
// suppressed digest leaves no EmailLog row either (see
// docs/EMAIL_DELIVERABILITY.md § 2d), and the current notificationPrefs value
// was the only evidence — with no when and no how.
//
// `ActivityLog.detail` is VARCHAR(191) in this schema and an oversized value is
// silently lost to P2000 (#1268), so the row records the changed *keys*, never
// the blob, and shrinks itself to fit.
const NOTIFICATION_DETAIL_MAX = 180;

function boolPrefs(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, boolean> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'boolean') out[key] = v;
  }
  return out;
}

interface NotificationState {
  emailNotifications: boolean;
  notificationPrefs: unknown;
}

// Which switches went off, which went on, and which keys the write dropped
// altogether (a PUT replaces the whole column, so a key can vanish and fall
// back to its group default — that is a change too, and a silent one).
function notificationDelta(before: NotificationState, after: NotificationState) {
  const off: string[] = [];
  const on: string[] = [];
  const cleared: string[] = [];
  if (before.emailNotifications !== after.emailNotifications) {
    (after.emailNotifications ? on : off).push('emailNotifications');
  }
  const b = boolPrefs(before.notificationPrefs);
  const a = boolPrefs(after.notificationPrefs);
  for (const [key, value] of Object.entries(a)) {
    if (b[key] === value) continue;
    (value ? on : off).push(key);
  }
  for (const key of Object.keys(b)) {
    if (!(key in a)) cleared.push(key);
  }
  return { off, on, cleared };
}

function renderDelta(lists: Array<[string, string[]]>, keep: number): string {
  const parts: string[] = [];
  let budget = keep;
  let dropped = 0;
  for (const [label, keys] of lists) {
    const shown = keys.slice(0, Math.max(0, budget));
    budget -= shown.length;
    dropped += keys.length - shown.length;
    if (shown.length > 0) parts.push(`${label}=${shown.join(',')}`);
  }
  if (dropped > 0) parts.push(`+${dropped}`);
  return parts.join(' ');
}

// 'via=/account' so the row is distinguishable from the token routes', whose
// detail carries a group id or 'one-click (RFC 8058)'.
function notificationDetail(delta: ReturnType<typeof notificationDelta>): string | null {
  const lists: Array<[string, string[]]> = [
    ['off', delta.off],
    ['on', delta.on],
    ['cleared', delta.cleared],
  ];
  const total = lists.reduce((n, [, keys]) => n + keys.length, 0);
  if (total === 0) return null;
  for (let keep = total; keep > 0; keep--) {
    const rendered = `via=/account ${renderDelta(lists, keep)}`;
    if (rendered.length <= NOTIFICATION_DETAIL_MAX) return rendered;
  }
  // A pathologically long single key: still say that something moved.
  return `via=/account ${total} keys changed`;
}

export async function GET() {
  try {
    const session = await getServerSession(authOptions);

    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    return await withTenantScope(session, async () => {
      const user = await prisma.user.findUnique({
        where: { id: session.user.id },
        select: PROFILE_SELECT,
      });

      if (!user) {
        return NextResponse.json({ error: 'User not found' }, { status: 404 });
      }

      // Mentor-only, derived availability (#941): how many mentees they're
      // currently carrying, plus the shared status/source/capacityKnown verdict
      // from getMentorAvailability() so callers never re-derive this logic.
      // Left off entirely for non-mentors — same response shape as before.
      if (user.role !== 'MENTOR') {
        return NextResponse.json({ user });
      }

      const activeMenteeCount = await prisma.mentorshipRelation.count({
        where: { mentorId: user.id, status: 'ACTIVE' },
      });
      const availability = getMentorAvailability({
        mentorCapacity: user.mentorCapacity,
        activeMenteeCount,
        acceptingMentees: user.acceptingMentees,
      });

      return NextResponse.json({ user: { ...user, activeMenteeCount, availability } });
    });
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

    return await withTenantScope(session, async () => {
      const body = await request.json();
      const protectedFields = forbiddenProfileFields(body, session.user.role);
      if (protectedFields.length > 0) {
        return NextResponse.json(
          { error: 'These profile fields cannot be changed', fields: protectedFields, code: 'protected_fields' },
          { status: 403 }
        );
      }
      const parsed = updateProfileSchema.safeParse(body);

      if (!parsed.success) {
        return NextResponse.json(
          { error: 'Validation failed', details: parsed.error.flatten() },
          { status: 400 }
        );
      }

      const { cvUrl, birthDate, ...rest } = parsed.data;

      // Read the switches back only when this write touches them; every other
      // profile save keeps its single query.
      const touchesNotifications =
        parsed.data.notificationPrefs !== undefined || parsed.data.emailNotifications !== undefined;
      const before = touchesNotifications
        ? await prisma.user.findUnique({
            where: { id: session.user.id },
            select: { emailNotifications: true, notificationPrefs: true },
          })
        : null;

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

      const delta = before ? notificationDelta(before, user) : null;
      const detail = delta ? notificationDetail(delta) : null;
      if (delta && detail) {
        // Reuse the token routes' action names so "who asked us to stop?" is one
        // query across all four opt-out surfaces. A single /account toggle sends
        // one changed key, so a mixed on+off write is a bulk client, not a human
        // clicking; it lands under 'email.unsubscribe' because the opt-out is the
        // half somebody will come asking about. A `cleared=` key is a fall back
        // to the group default, which for a dropped opt-out means back ON.
        await logActivity({
          action: delta.off.length > 0 ? 'email.unsubscribe' : 'email.resubscribe',
          actorId: session.user.id,
          actorEmail: session.user.email ?? null,
          targetType: 'user',
          targetId: session.user.id,
          detail,
          request,
        });
      }
      // Still record the plain profile edit when the write changed anything else
      // (or changed nothing at all) — this row predates the delta one.
      const changedOtherFields = Object.keys(parsed.data).some(
        (field) => field !== 'notificationPrefs' && field !== 'emailNotifications'
      );
      if (changedOtherFields || !detail) {
        await logActivity({ action: 'profile.update', actorId: session.user.id, actorEmail: session.user.email ?? null });
      }
      return NextResponse.json({ user });
    });
  } catch (error) {
    console.error('Update profile error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
