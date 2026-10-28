import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { z } from 'zod';
import { enforceRateLimit } from '@/lib/rateLimit';
import { checkPassword, passwordRefusal, passwordSchema } from '@/lib/password';
import { provisionOrganization, orgSlugAvailable } from '@/lib/orgProvisioning';
import { slugifyOrg, ORG_SLUG_MAX } from '@/lib/orgSlug';
import { getOrCreateSubscription } from '@/lib/subscription';
import { emailTakenInWorld } from '@/lib/userWorld';
import { hostVertical } from '@/lib/hostVertical';
import { DEFAULT_VERTICAL } from '@/lib/verticals';
import { PRIVACY_POLICY_VERSION } from '@/lib/privacy';
import { isValidTimeZone } from '@/lib/timezone';
import { defaultLocale, locales } from '@/i18n/config';
import { createEmailVerificationToken } from '@/lib/emailVerification';
import { sendEmail, sendVerificationEmail } from '@/services/emailService';
import { logActivity } from '@/lib/activity';
import { logger } from '@/lib/logger';
import { selfServeSignupEnabled, SIGNUP_ORG_RATE_LIMIT } from '@/lib/selfServeSignup';

// Self-serve tenant signup (#1749, story #1747): one unauthenticated POST that
// turns a form into a working tenant — an INTERNSHIP organization (Community =
// plan FREE), its first ADMIN, that admin's privacy consent and the org's
// Subscription row — through provisionOrganization() (#2065), so the
// organization half is the exact code the super admin's wizard runs, starter
// pack included (#2066). Everything is ONE transaction: the account, consent
// and subscription are created by the `firstAdminAccount` step inside it, so a
// failure anywhere leaves no rows at all.
//
// Five rules are load-bearing:
//   1. OFF unless SELF_SERVE_SIGNUP=true, checked here in the handler (503
//      `not_enabled`), never only on the page.
//   2. Never a session. The account is created inactive and unverified and
//      admits itself through the ordinary verification link — the same
//      activation story open registration has (verify-email flips isActive).
//   3. Not an enumeration oracle: an address already in this product answers
//      exactly what an unusable organization name answers (409
//      `signup_unavailable`). A taken slug never surfaces at all — it gets a
//      short random suffix instead of turning a visitor away.
//   4. The response names nothing that was created: no user id, no org id.
//   5. INTERNSHIP only. A MARKETING host is invitation-only (#2501) and gets
//      the same 403 /api/register gives it — the TRUST NOTE in hostVertical.ts
//      permits exactly this: a forged host can only refuse the forger's own
//      request. The new tenant's product is never read from the header.

const signupSchema = z.object({
  orgName: z.string().trim().min(1).max(120),
  slug: z.string().trim().max(ORG_SLUG_MAX).optional(),
  fullName: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(191),
  password: passwordSchema,
  consent: z.literal(true),
  privacyVersion: z.string().max(32).optional(),
  locale: z.enum(locales).optional(),
  timezone: z.string().max(80).optional(),
});

const UNAVAILABLE = { error: 'This sign-up could not be completed. If you already have an account, sign in instead.', code: 'signup_unavailable' } as const;
const SLUG_ATTEMPTS = 4;

function withSuffix(base: string): string {
  const suffix = randomBytes(3).toString('hex').slice(0, 5);
  return `${base.slice(0, ORG_SLUG_MAX - suffix.length - 1).replace(/-+$/g, '')}-${suffix}`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export async function POST(request: Request) {
  if (!selfServeSignupEnabled()) {
    return NextResponse.json({ error: 'Self-serve signup is not enabled', code: 'not_enabled' }, { status: 503 });
  }
  const limited = enforceRateLimit(request, 'signup-org', SIGNUP_ORG_RATE_LIMIT);
  if (limited) return limited;

  const parsed = signupSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
  }
  if ((await hostVertical()) !== DEFAULT_VERTICAL) {
    return NextResponse.json(
      { error: 'Registration on this product is by invitation only', code: 'invitation_required' },
      { status: 403 },
    );
  }

  const d = parsed.data;
  const vertical = DEFAULT_VERTICAL;
  const email = d.email.toLowerCase();
  const locale = d.locale ?? defaultLocale;

  // provisionOrganization() asks the same question again; asking first keeps
  // the bcrypt and the breach lookup off the refused path.
  if (await emailTakenInWorld(email, vertical)) {
    return NextResponse.json(UNAVAILABLE, { status: 409 });
  }
  // The new org has no settings of its own yet, so the deployment default
  // policy (the org-less read of the chain) is the one it will start with.
  const verdict = await checkPassword(d.password, null);
  if (!verdict.ok) return passwordRefusal(verdict);
  const hashedPassword = await bcrypt.hash(d.password, 12);

  const base = slugifyOrg(d.slug || d.orgName) || 'org';
  let slug = base;
  const timezone = isValidTimeZone(d.timezone) ? d.timezone : null;
  // The rollback proof (#1749): e2e/signup-org.spec.ts makes the LAST step in
  // the transaction throw and asserts nothing survived. Same test-only switch
  // as the throwing error routes (#1602) — unset on every deployment.
  const forceFailure = process.env.E2E_ERROR_ROUTES === '1' && request.headers.get('x-e2e-fail-signup') === '1';

  for (let attempt = 0; attempt < SLUG_ATTEMPTS; attempt++) {
    if (attempt > 0 || !(await orgSlugAvailable(slug))) slug = withSuffix(base);
    const result = await provisionOrganization({
      name: d.orgName,
      slug,
      vertical,
      plan: 'FREE',
      starterPack: true,
      sampleProgram: false,
      locale,
      request,
      firstAdminAccount: {
        email,
        create: async (tx, organization) => {
          const now = new Date();
          const user = await tx.user.create({
            data: {
              email,
              password: hashedPassword,
              fullName: d.fullName,
              role: 'ADMIN',
              skills: [],
              orgId: organization.id,
              // Inactive and unverified: the verification link admits it.
              emailVerified: false,
              isActive: false,
              pendingApproval: false,
              consentAt: now,
              timezone,
              preferredLanguage: d.locale ?? null,
            },
            select: { id: true, email: true },
          });
          await tx.userConsent.create({
            data: { userId: user.id, type: 'PRIVACY_POLICY', version: d.privacyVersion ?? PRIVACY_POLICY_VERSION, grantedAt: now },
          });
          await getOrCreateSubscription(organization.id, tx);
          if (forceFailure) throw new Error('e2e: forced self-serve signup failure');
          return user;
        },
      },
    });
    if (!result.ok) {
      if (result.refusal.code === 'slug_taken') continue;
      // email_taken_in_world (a race with another signup) or a slug that could
      // not be derived: the same answer as a taken address, by design.
      return NextResponse.json(UNAVAILABLE, { status: 409 });
    }

    const { organization, account } = result.value;
    if (account) {
      try {
        const token = await createEmailVerificationToken(account.id);
        await sendVerificationEmail({ to: account.email, token, fullName: d.fullName, orgId: organization.id, locale: d.locale ?? null });
      } catch (e) {
        // The account exists and the sign-in page offers a resend
        // (EMAIL_NOT_VERIFIED), so a mail hiccup is not a failed signup.
        logger.error('signup_org.verification_mail_failed', { orgId: organization.id, error: e instanceof Error ? e.name : 'unknown' });
      }
    }
    await logActivity({
      action: 'org.self_signup',
      actorId: account?.id ?? null,
      targetType: 'organization',
      targetId: organization.id,
      detail: organization.slug,
    });
    await notifyOperator(organization);
    return NextResponse.json({ ok: true, orgSlug: organization.slug }, { status: 201 });
  }
  return NextResponse.json(UNAVAILABLE, { status: 409 });
}

// A real signup is never invisible to the operator: one line to the operator
// address. Organization name and slug only — the person's address and name
// stay in the tenant.
async function notifyOperator(organization: { id: string; name: string; slug: string }) {
  const alertTo = process.env.ALERT_EMAIL_TO;
  if (!alertTo) return;
  try {
    await sendEmail({
      to: alertTo,
      subject: `New self-serve organization: ${organization.slug}`,
      html: `<p>A new Community organization signed up: <strong>${escapeHtml(organization.name)}</strong> (<code>${escapeHtml(organization.slug)}</code>).</p>`,
      category: 'ops-alert',
      dedupeKey: `signup-org:${organization.id}`,
      queueOnly: true,
      // no-user-row: ALERT_EMAIL_TO is an operator address from the server
      // env, not a User row — no preference to read, no unsubscribe token.
    });
  } catch (e) {
    logger.error('signup_org.operator_notice_failed', { orgId: organization.id, error: e instanceof Error ? e.name : 'unknown' });
  }
}
