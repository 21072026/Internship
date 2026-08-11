import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { IS_DEMO_MODE } from '@/lib/demoMode';
import bcrypt from 'bcryptjs';

// Shared credentials recreated on every reset.
const DEMO_USERS = [
  { email: 'demo-admin@ersah.in', fullName: 'Demo Admin', role: 'ADMIN' as const },
  { email: 'demo-mentor@ersah.in', fullName: 'Demo Mentor', role: 'MENTOR' as const },
  { email: 'demo-mentee@ersah.in', fullName: 'Demo Mentee', role: 'MENTEE' as const },
] as const;

const DEMO_PASSWORD = 'Demo1234!';

/**
 * POST /api/demo/reset
 *
 * Wipes all user-generated data and recreates the demo seed accounts.
 * Requires the Authorization header to carry the DEMO_RESET_SECRET so only
 * the external scheduler (cron job / GitHub Actions) can trigger it.
 *
 * This endpoint is only active when DEMO_MODE=true.  On any other instance it
 * returns 404 so that the route does not become an unintended attack surface.
 *
 * Reset strategy: delete leaf tables first (no outgoing FK constraints on the
 * tables we are deleting), then delete User rows (Prisma cascades the rest
 * via onDelete: Cascade in the schema).
 */
export async function POST(req: Request) {
  if (!IS_DEMO_MODE) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const secret = process.env.DEMO_RESET_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'Demo reset secret not configured' }, { status: 500 });
  }

  const auth = req.headers.get('authorization') ?? '';
  if (auth !== 'Bearer ' + secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    await runReset();
    return NextResponse.json({ ok: true, resetAt: new Date().toISOString() });
  } catch (err) {
    console.error('[demo/reset] failed:', err);
    return NextResponse.json({ error: 'Reset failed' }, { status: 500 });
  }
}

async function runReset() {
  // Delete in dependency order so FK constraints are not violated.
  // User rows carry onDelete: Cascade for most child records in the schema, so
  // deleting all users cleans up the bulk of the data. Leaf tables that do NOT
  // cascade from User are cleaned first.
  await prisma.interactionLog.deleteMany();
  await prisma.mentorshipRelation.deleteMany();
  await prisma.invitationToken.deleteMany();
  await prisma.passwordResetToken.deleteMany();
  await prisma.emailVerificationToken.deleteMany();
  await prisma.user.deleteMany();

  const hashed = await bcrypt.hash(DEMO_PASSWORD, 10);

  // Create users and record their IDs so we can create relationships.
  const created: Partial<Record<'ADMIN' | 'MENTOR' | 'MENTEE', string>> = {};
  for (const u of DEMO_USERS) {
    const user = await prisma.user.create({
      data: {
        email: u.email,
        fullName: u.fullName,
        role: u.role,
        password: hashed,
        emailVerified: true,
        skills: [],
        publicProfile: u.role !== 'ADMIN',
      },
    });
    created[u.role] = user.id;
  }

  // Wire up a mentorship between the mentor and the mentee so there is
  // something to look at in the pipeline view.
  if (created.MENTOR && created.MENTEE) {
    await prisma.mentorshipRelation.create({
      data: {
        mentorId: created.MENTOR,
        menteeId: created.MENTEE,
        status: 'ACTIVE',
      },
    });
  }
}
