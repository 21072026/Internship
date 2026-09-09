import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { generateSecret, verifyTotp, otpauthUrl } from '@/lib/totp';
import { logActivity } from '@/lib/activity';
import { withTenantScope } from '@/lib/orgContext';
import {
  clearRecoveryCodes,
  generateRecoveryCodes,
  recoveryCodeStatus,
} from '@/lib/recoveryCodes';

// GET — current 2FA status. Readable while impersonating (it is the account's
// security posture, which an admin looking at the account may legitimately see);
// only the mutations below are refused.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return await withTenantScope(session, async () => {
  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { twoFactorEnabled: true } });
  // Counts, never codes (#1542). The plaintext existed once, at enrolment; the
  // account page can only ever learn how many are left — which is the thing the
  // user actually needs to know, because a spent or exhausted set is invisible
  // otherwise and they would discover it on the day they need it.
  const codes = await recoveryCodeStatus(session.user.id);
  return NextResponse.json({
    enabled: !!user?.twoFactorEnabled,
    recoveryCodes: {
      total: codes.total,
      remaining: codes.remaining,
      generatedAt: codes.generatedAt?.toISOString() ?? null,
    },
  });
  });
}

const schema = z.object({
  action: z.enum(['setup', 'enable', 'disable', 'regenerate-codes']),
  code: z.string().optional(),
});

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Nobody but the account holder changes the account holder's second factor
  // (#1039). Inside an impersonation session `setup`/`enable` would enrol an
  // authenticator the owner does not possess — a permanent back door that
  // survives the 30-minute impersonation window — and `disable` would strip the
  // factor that protects them, including from the admin doing it. Both would be
  // written to the activity log as the *user*, so the audit trail would name the
  // wrong person. Same 400 as the credential changes on /api/account.
  if (session.user.impersonatorId) {
    return NextResponse.json({ error: 'Cannot change two-factor authentication while impersonating' }, { status: 400 });
  }

  return await withTenantScope(session, async () => {
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  const { action, code } = parsed.data;

  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { email: true, twoFactorSecret: true, twoFactorEnabled: true } });
  if (!user) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  if (action === 'setup') {
    // Generate (or regenerate while still disabled) a pending secret.
    const secret = generateSecret();
    await prisma.user.update({ where: { id: session.user.id }, data: { twoFactorSecret: secret, twoFactorEnabled: false } });
    return NextResponse.json({ secret, otpauth: otpauthUrl(secret, user.email) });
  }

  if (action === 'enable') {
    if (!user.twoFactorSecret) return NextResponse.json({ error: 'Run setup first' }, { status: 400 });
    if (!code || !verifyTotp(user.twoFactorSecret, code)) {
      return NextResponse.json({ error: 'Invalid authenticator code' }, { status: 400 });
    }
    await prisma.user.update({ where: { id: session.user.id }, data: { twoFactorEnabled: true } });
    // Minted here rather than on request: a second factor with no way back in
    // is the trap this feature exists to close, and a user who has to go and
    // find a "generate codes" button is a user who never has any.
    const recoveryCodes = await generateRecoveryCodes(session.user.id);
    await logActivity({ action: '2fa.enable', actorId: session.user.id, actorEmail: session.user.email ?? null });
    // The one and only response that carries the plaintext.
    return NextResponse.json({ enabled: true, recoveryCodes });
  }

  if (action === 'regenerate-codes') {
    if (!user.twoFactorEnabled) return NextResponse.json({ error: 'Enable 2FA first' }, { status: 400 });
    // Deliberately NOT gated on a fresh authenticator code, unlike `disable`.
    // The person who most needs a new set is the one who just signed in with a
    // recovery code because their authenticator is gone — asking them for a
    // TOTP code would lock the door behind them and leave the account with a
    // dwindling set it can never refill. The session itself is the proof: they
    // are through the second factor (by either route), they are not being
    // impersonated (refused above), and the old set dies with this call.
    const recoveryCodes = await generateRecoveryCodes(session.user.id);
    await logActivity({
      action: '2fa.recovery_codes_regenerated',
      level: 'warning',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
    });
    return NextResponse.json({ recoveryCodes });
  }

  // disable — require a valid code to turn it off.
  if (!user.twoFactorEnabled) return NextResponse.json({ enabled: false });
  if (!user.twoFactorSecret || !code || !verifyTotp(user.twoFactorSecret, code)) {
    return NextResponse.json({ error: 'Invalid authenticator code' }, { status: 400 });
  }
  await prisma.user.update({ where: { id: session.user.id }, data: { twoFactorEnabled: false, twoFactorSecret: null } });
  // The codes are part of the second factor, so they go with it — leaving them
  // behind would keep a set of live credentials for a factor nobody checks any
  // more, and re-enabling 2FA later would silently inherit them.
  await clearRecoveryCodes(session.user.id);
  await logActivity({ action: '2fa.disable', level: 'warning', actorId: session.user.id, actorEmail: session.user.email ?? null });
  return NextResponse.json({ enabled: false });
  });
}
