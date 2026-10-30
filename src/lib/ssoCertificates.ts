// IdP signing certificates as a LIST (#1955). Pure and dependency-free: the
// write boundary (src/lib/sso.ts), the SAML instance (src/lib/ssoSaml.ts) and the
// browserless unit spec all read the stored column through this one function.

/**
 * Every IdP signing certificate the tenant trusts (#1955). The column holds one
 * or more PEM blocks: during a key rotation the IdP's current AND next
 * certificate are both pasted in, an assertion signed by either verifies, and
 * the old one is removed once the IdP has switched — a scheduled change rather
 * than an outage. A bare base64 body (no PEM armour) stays one certificate.
 */
export function idpCertificates(stored: string | null | undefined): string[] {
  const text = (stored ?? '').trim();
  if (!text) return [];
  const blocks = text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  return blocks && blocks.length ? blocks : [text];
}

