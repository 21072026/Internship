import { NextResponse, after } from 'next/server';
import { z } from 'zod';
import { enforceRateLimit, clientIp } from '@/lib/rateLimit';
import { findAccountsForMailedLink } from '@/lib/passwordReset';
import { createLoginLinkToken } from '@/lib/magicLink';
import { sendMagicLinkEmail } from '@/services/emailService';
import { isPasswordLoginBlocked } from '@/lib/ssoEnforcement';
import { worldForHeaders } from '@/lib/hostWorld';

const schema = z.object({ email: z.string().email() });

// "E-mail me a sign-in link" (#1959). The same door as /api/auth/forgot, built
// the same way: whoever is here cannot sign in, so there is no session; the
// answer is the same 200 whether or not the address has an account; and the
// User read is column-scoped — this is a way back in, so it must not share
// sign-in's failure modes (a corrupt Json column, #1150). No Json column may
// ever be added here (scripts/check-auth-reads.mjs).
//
// The link is a password-equivalent credential, so every account state that
// refuses a password refuses a link, silently: inactive, unverified, waiting
// for approval, or a tenant that enforces SSO (#1950) — the mail is simply not
// sent, and the response does not change.
const LINK_TARGET_SELECT = {
  id: true,
  email: true,
  fullName: true,
  orgId: true,
  ssoExempt: true,
  isActive: true,
  emailVerified: true,
  pendingApproval: true,
  preferredLanguage: true,
} as const;

const LIMIT = { limit: 5, windowMs: 15 * 60 * 1000 } as const;

export async function POST(request: Request) {
  // Per IP first — before the body is even read — then per address: the
  // per-address bucket alone lets one machine spray a list, the per-IP bucket
  // alone lets a botnet hammer one mailbox. Both answer the same 429.
  const limitedByIp = enforceRateLimit(request, 'magic-link', LIMIT);
  if (limitedByIp) return limitedByIp;

  try {
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid email' }, { status: 400 });
    }
    const email = parsed.data.email.trim().toLowerCase();
    const limitedByEmail = enforceRateLimit(request, 'magic-link-email', { ...LIMIT, subject: email });
    if (limitedByEmail) return limitedByEmail;

    // WHICH ACCOUNT (#2590): the host this form was served from is the product,
    // and an address with no account in this world gets no mail — never one
    // from the other product. Identical response either way.
    const world = worldForHeaders((name) => request.headers.get(name));
    const targets = await findAccountsForMailedLink(email, world, LINK_TARGET_SELECT);
    const ip = clientIp(request);

    for (const user of targets) {
      // Every refusal below is silent: the response is the same, no mail goes
      // out, and the account's state is not disclosed to whoever typed the
      // address. The `magic` provider re-checks each of these at redemption —
      // a state can change inside the link's fifteen minutes.
      if (!user.isActive || !user.emailVerified || user.pendingApproval) continue;
      if (await isPasswordLoginBlocked(user)) continue;

      const token = await createLoginLinkToken(user.id, ip);
      // Sent AFTER the response has gone out: an SMTP round-trip on the known
      // path only would be a timing oracle for "this address has an account".
      // The token row already exists, so a failed send loses one mail, not the
      // invariant; the next request retires it and mints another.
      after(async () => {
        try {
          await sendMagicLinkEmail({
            to: user.email,
            token,
            fullName: user.fullName,
            orgId: user.orgId,
            locale: user.preferredLanguage,
          });
        } catch (e) {
          console.error('Magic link email failed:', e);
        }
      });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Magic link request error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
