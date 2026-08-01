/**
 * The server secret used to sign HMAC tokens (reply addresses, consent-renewal
 * links).
 *
 * `replyToken.ts` and `consentRenew.ts` each used to fall back to a hard-coded
 * `'dev-secret'` when `NEXTAUTH_SECRET` was unset (#870). This repository is
 * public, so that value is known to everyone: an environment missing the secret
 * would happily verify tokens anyone could mint — reply tokens route an inbound
 * email into a message thread, and consent-renewal tokens record consent on
 * someone else's behalf.
 *
 * Failing loudly is the point. A deployment without `NEXTAUTH_SECRET` cannot
 * authenticate anyone anyway (NextAuth needs it too), so there is no working
 * configuration this breaks — only a silently insecure one.
 */
export function requireServerSecret(): string {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new Error(
      'NEXTAUTH_SECRET is not set. It signs reply and consent-renewal tokens; ' +
        'there is no default, because a public default is the same as no signature.'
    );
  }
  return secret;
}
