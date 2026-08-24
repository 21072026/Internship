import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import crypto from 'crypto';
import { z } from 'zod';
import { createPasswordResetToken } from '@/lib/passwordReset';
import { sendPasswordResetEmail } from '@/services/emailService';
import { slugify } from '@/lib/transliterate';
import { checkActiveRelationLimit, planLimitError } from '@/lib/planGate';
import { resolveOrgId } from '@/lib/orgScope';
import { withTenantScope } from '@/lib/orgContext';
import { NO_LOGIN_PASSWORD, PLACEHOLDER_EMAIL_DOMAIN } from '@/lib/menteeAccount';
import { findPossibleDuplicates } from '@/lib/duplicateDetection';

const schema = z.object({
  fullName: z.string().min(1),
  email: z.string().email().optional().or(z.literal('')),
  phone: z.string().optional(),
  whatsapp: z.string().optional(),
  city: z.string().optional(),
  university: z.string().optional(),
  department: z.string().optional(),
  // Legacy free-text referral. Still accepted so older clients keep working;
  // the form now sends the merged referrer below instead (#1296).
  referralSource: z.string().optional(),
  // Who brought this mentee in — one field, two possible kinds: a registered
  // person or a Source row. Never both (#1296).
  referredById: z.string().optional().nullable(),
  sourceId: z.string().optional().nullable(),
  // Set on resubmit after the duplicate warning (#841): "yes, create anyway".
  confirmDuplicate: z.boolean().optional(),
});

// A mentor (or admin) creates a mentee and assigns it to themselves in one step.
export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session || (session.user.role !== 'MENTOR' && session.user.role !== 'ADMIN')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return await withTenantScope(session, async () => {
      const parsed = schema.safeParse(await request.json());
      if (!parsed.success) {
        return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
      }
      const { fullName, email, ...rest } = parsed.data;

      // A real email means the mentee can be invited to set a password and log in.
      // No email → a deterministic placeholder for a tracking-only mentee (no login).
      // Not a dead end: once the mentor learns the real address, PATCH on this
      // route's [id] child fixes it and sends the activation link (#1123).
      const hasRealEmail = !!(email && email.length > 0);
      const finalEmail = hasRealEmail
        ? email!.trim().toLowerCase()
        : `mentee.${slugify(fullName)}.${crypto.randomBytes(2).toString('hex')}@${PLACEHOLDER_EMAIL_DOMAIN}`;

      const existing = await prisma.user.findUnique({ where: { email: finalEmail } });
      if (existing) {
        return NextResponse.json({ error: 'A user with this email already exists' }, { status: 409 });
      }

      // Plan gate (#547): a new mentee here means a new active relation. Gate on
      // the creating user's tenant before creating anything. No-op for the
      // unlimited default org.
      const orgId = resolveOrgId(session);
      const gate = await checkActiveRelationLimit(orgId);
      if (!gate.allowed) {
        return NextResponse.json(planLimitError(gate), { status: 403 });
      }

      // Duplicate pre-flight (#841): warn — never auto-merge, never block. The
      // mentor sees the matches and resubmits with confirmDuplicate to proceed.
      const duplicates = await findPossibleDuplicates({
        orgId,
        fullName,
        email: hasRealEmail ? finalEmail : null,
        phone: rest.phone,
        whatsapp: rest.whatsapp,
        university: rest.university,
      });
      if (duplicates.length > 0 && !parsed.data.confirmDuplicate) {
        return NextResponse.json(
          {
            error: 'possible_duplicate',
            possibleDuplicates: duplicates.map((m) => ({
              id: m.id,
              fullName: m.fullName,
              email: m.email,
              university: m.university,
              signals: m.signals,
            })),
          },
          { status: 409 },
        );
      }

      // The merged referrer (#1296). Exactly one kind may be set, and a person
      // referrer must be a real person-role account — the same rule
      // `PATCH /api/users/[id]` enforces, so both entry points agree.
      const referredById = rest.referredById || null;
      const sourceId = rest.sourceId || null;
      if (referredById && sourceId) {
        return NextResponse.json(
          { error: 'A person has one referrer: pass either referredById or sourceId, not both' },
          { status: 400 },
        );
      }
      if (referredById) {
        const referrer = await prisma.user.findUnique({ where: { id: referredById }, select: { role: true } });
        if (!referrer || !['ADMIN', 'MENTOR', 'MENTEE'].includes(referrer.role)) {
          return NextResponse.json({ error: 'Invalid source user' }, { status: 400 });
        }
      }
      if (sourceId) {
        const source = await prisma.source.findUnique({ where: { id: sourceId }, select: { id: true } });
        if (!source) return NextResponse.json({ error: 'Source not found' }, { status: 400 });
      }

      const mentee = await prisma.user.create({
        data: {
          email: finalEmail,
          password: NO_LOGIN_PASSWORD,
          role: 'MENTEE',
          fullName,
          orgId,
          skills: [],
          phone: rest.phone || null,
          whatsapp: rest.whatsapp || null,
          city: rest.city || null,
          university: rest.university || null,
          department: rest.department || null,
          referralSource: rest.referralSource || null,
          referredById,
          sourceId,
        },
      });

      await prisma.mentorshipRelation.create({
        data: { mentorId: session.user.id, menteeId: mentee.id, orgId },
      });

      // If the mentee has a real email, send a "set your password" link so they
      // can activate their account. The link is also returned so the UI can show
      // it (and the mentor can share it manually) even if the email fails.
      let setPasswordUrl: string | null = null;
      if (hasRealEmail) {
        const token = await createPasswordResetToken(mentee.id, 'SET_INITIAL');
        const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
        setPasswordUrl = `${appUrl}/auth/reset?token=${token}`;
        try {
          await sendPasswordResetEmail({
            to: mentee.email,
            token,
            fullName: mentee.fullName,
            purpose: 'SET_INITIAL',
            orgId,
          });
        } catch (e) {
          console.error('Mentee set-password email failed:', e);
        }
      }

      return NextResponse.json({ menteeId: mentee.id, setPasswordUrl }, { status: 201 });
    });
  } catch (error) {
    console.error('Create mentee error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
