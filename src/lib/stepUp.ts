import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/prisma';
import { requireSecondFactor } from '@/lib/auth';
import { logActivity } from '@/lib/activity';
import { rateLimit } from '@/lib/rateLimit';
import { getActiveLockout, recordFailedAttempt } from '@/lib/accountLockout';
import { isPasswordLoginBlocked } from '@/lib/ssoEnforcement';
import { clientIp, type HeaderSource } from '@/lib/clientIp';

// Step-up: proving it is still the account holder at the moment of one
// sensitive write, inside an already signed-in session (#3734). The first
// caller is the partner's IBAN change — a hijacked session would otherwise
// redirect money with no further question.
//
// Which proof is asked is the account's own, never the caller's choice:
//   - 2FA enrolled → a live TOTP code or a recovery code, through the SAME
//     requireSecondFactor() the sign-in doors use (src/lib/auth.ts): its
//     2FA_REQUIRED handshake, its durable lockouts, the two recovery buckets
//     and the replay floor. There is deliberately no second TOTP check here.
//   - no 2FA → the current password, charged to the SAME counters a wrong
//     sign-in password is (`login-fail:<email>`, the `password` lockout, 10 per
//     15 minutes), so the step-up cannot be used to guess the password around
//     the sign-in limit.
//   - no 2FA and no password to ask — a tenant that enforces SSO, or an account
//     SSO provisioned with a marker instead of a hash → refused as
//     `step_up_unavailable`: enrol 2FA first.
//
// Never logs the code or the password; the refusals do not say which part of
// the proof was wrong beyond what the sign-in form already says.

export type StepUpMethod = 'totp' | 'password';
export type StepUpRefusal = 'step_up_required' | 'step_up_invalid' | 'step_up_locked' | 'step_up_unavailable';
export type StepUpResult = { ok: true; method: StepUpMethod } | { ok: false; code: StepUpRefusal; method: StepUpMethod | null; status: 400 | 403 | 429 };

export interface StepUpInput {
  /** A TOTP code or a recovery code (2FA accounts). */
  code?: unknown;
  /** The current password (accounts without 2FA). */
  password?: unknown;
}

const STEP_UP_SELECT = {
  id: true,
  email: true,
  orgId: true,
  password: true,
  ssoExempt: true,
  twoFactorEnabled: true,
  twoFactorSecret: true,
  lastTotpStep: true,
} as const;

/** Which proof this account is asked for, or null when it has none to give. */
export async function stepUpMethodFor(userId: string): Promise<StepUpMethod | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: STEP_UP_SELECT });
  if (!user) return null;
  if (user.twoFactorEnabled && user.twoFactorSecret) return 'totp';
  return !hasPassword(user) || (await isPasswordLoginBlocked(user)) ? null : 'password';
}

const text = (v: unknown) => (typeof v === 'string' ? v : '');

// An account provisioned by SSO stores a marker, not a hash (ssoProvisioning.ts):
// it has no password its owner could type. Asking for one would only burn the
// sign-in password counters, so such an account is sent to 2FA instead.
const BCRYPT_HASH = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;
const hasPassword = (user: { password: string }) => BCRYPT_HASH.test(user.password);

export async function verifyStepUp(userId: string, input: StepUpInput, request: Request, action: string): Promise<StepUpResult> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: STEP_UP_SELECT });
  if (!user) return { ok: false, code: 'step_up_unavailable', method: null, status: 403 };
  // A Request is a header source as it stands (`headers.get`).
  const origin: HeaderSource = request;
  const email = user.email.toLowerCase();
  const ip = clientIp(origin);

  if (user.twoFactorEnabled && user.twoFactorSecret) {
    try {
      await requireSecondFactor(
        { id: user.id, email: user.email, orgId: user.orgId, twoFactorSecret: user.twoFactorSecret, lastTotpStep: user.lastTotpStep },
        text(input.code),
        { email, ip, origin },
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : '';
      if (message === '2FA_REQUIRED') return { ok: false, code: 'step_up_required', method: 'totp', status: 403 };
      if (message.startsWith('Too many attempts')) return { ok: false, code: 'step_up_locked', method: 'totp', status: 429 };
      return { ok: false, code: 'step_up_invalid', method: 'totp', status: 403 };
    }
    await logActivity({ action: 'auth.step_up', actorId: user.id, actorEmail: user.email, detail: `${action} (totp)`, request: origin });
    return { ok: true, method: 'totp' };
  }

  if (!hasPassword(user) || (await isPasswordLoginBlocked(user))) return { ok: false, code: 'step_up_unavailable', method: null, status: 403 };
  const password = text(input.password);
  if (!password) return { ok: false, code: 'step_up_required', method: 'password', status: 403 };
  if (await getActiveLockout(email, 'password')) return { ok: false, code: 'step_up_locked', method: 'password', status: 429 };

  if (!(await bcrypt.compare(password, user.password))) {
    // The sign-in door's own counters (src/lib/auth.ts, credentials provider).
    const within = rateLimit(`login-fail:${email}`, { limit: 10, windowMs: 15 * 60 * 1000 });
    const locked = await recordFailedAttempt({ email, userId: user.id, orgId: user.orgId, reason: 'password', limit: 10, ip });
    await logActivity({ action: 'auth.step_up_failed', level: 'warning', actorId: user.id, actorEmail: user.email, detail: `${action} (password)`, request: origin });
    return within.ok && !locked
      ? { ok: false, code: 'step_up_invalid', method: 'password', status: 403 }
      : { ok: false, code: 'step_up_locked', method: 'password', status: 429 };
  }
  await logActivity({ action: 'auth.step_up', actorId: user.id, actorEmail: user.email, detail: `${action} (password)`, request: origin });
  return { ok: true, method: 'password' };
}
