// Our SAML signing key, per organization (#1952). Single Logout is the first
// SAML message WE sign: an IdP must be able to tell our LogoutRequest and
// LogoutResponse from a forged one, so they carry a signature it verifies
// against the certificate in our SP metadata.
//
// WHERE THE KEY LIVES — the decision #1952 asked for:
//   • PER ORGANIZATION, not one deployment-wide key. An IdP trusts one SP
//     entity (`/sso/<slug>`); a shared key would make every tenant's IdP trust
//     messages any other tenant's configuration could cause us to sign, and
//     rotating it would break every tenant at once.
//   • IN THE DATABASE, SEALED — `Organization.ssoSpKey` holds the PKCS#8 PEM
//     sealed with secretBox (AES-256-GCM under an HKDF key from NEXTAUTH_SECRET,
//     purpose 'sso-sp-signing-key'), the same at-rest pattern as the Google
//     refresh tokens. A dump or a read-only SQL injection yields no usable key.
//     No new env secret: an operator has nothing to provision per tenant, and
//     there is no file to lose on a redeploy.
//   • GENERATED ON FIRST USE (metadata, logout), once: the write is a
//     conditional update on `ssoSpKey: null`, so two concurrent first uses
//     cannot leave two different keys behind — the loser reads the winner's.
//   • If the sealed key cannot be opened (NEXTAUTH_SECRET rotated, row copied
//     between environments) it is replaced, loudly: the tenant's IdP then needs
//     our metadata re-imported, which the log line says.
//
// Server-only.

import { generateKeyPairSync } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { open, seal } from '@/lib/secretBox';
import { selfSignedCertificate } from '@/lib/x509SelfSigned';

const PURPOSE = 'sso-sp-signing-key';
const VALID_YEARS = 10;

export interface SpSigningKey {
  privateKeyPem: string;
  certificatePem: string;
}

function mint(slug: string): { privateKeyPem: string; certificatePem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const notBefore = new Date(Date.now() - 60_000);
  const notAfter = new Date(notBefore);
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + VALID_YEARS);
  const certificatePem = selfSignedCertificate(publicKey, privateKey, `sso-sp-${slug}`.slice(0, 64), { notBefore, notAfter });
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  return { privateKeyPem, certificatePem };
}

/** The org's SP signing key, created on first use. */
export async function ensureSpSigningKey(org: {
  id: string;
  slug: string;
  ssoSpKey: string | null;
  ssoSpCert: string | null;
}): Promise<SpSigningKey> {
  if (org.ssoSpKey && org.ssoSpCert) {
    const privateKeyPem = open(org.ssoSpKey, PURPOSE);
    if (privateKeyPem) return { privateKeyPem, certificatePem: org.ssoSpCert };
    logger.warning('SSO SP signing key could not be opened; replacing it — the IdP must re-import our metadata', { orgId: org.id });
  }

  const fresh = mint(org.slug);
  const won = await prisma.organization.updateMany({
    // The stale value we read, or null: replace only what we saw, so a key
    // another request installed meanwhile survives.
    where: { id: org.id, ssoSpKey: org.ssoSpKey },
    data: { ssoSpKey: seal(fresh.privateKeyPem, PURPOSE), ssoSpCert: fresh.certificatePem },
  });
  if (won.count === 1) return fresh;

  const current = await prisma.organization.findUnique({
    where: { id: org.id },
    select: { ssoSpKey: true, ssoSpCert: true },
  });
  const privateKeyPem = current?.ssoSpKey ? open(current.ssoSpKey, PURPOSE) : null;
  if (!privateKeyPem || !current?.ssoSpCert) throw new Error('SSO SP signing key unavailable');
  return { privateKeyPem, certificatePem: current.ssoSpCert };
}

/**
 * The org's SP private key IF one exists — never creates one (#1955). The ACS
 * decrypts an encrypted assertion with it: a key the IdP encrypted for must
 * already be published, so there is nothing to mint at that point. A key that
 * cannot be opened answers null; ensureSpSigningKey() is where it is replaced.
 */
export function existingSpPrivateKey(org: { ssoSpKey: string | null }): string | null {
  return org.ssoSpKey ? open(org.ssoSpKey, PURPOSE) : null;
}
