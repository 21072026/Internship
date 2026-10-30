// The node-saml instance the SAML sign-in routes use (#1955): the tenant's
// IdP config plus the protocol hardening it switched on. Server-only.
//
//   login route  builds the AuthnRequest — signed when `ssoSignRequests` (the
//                key is created here if the tenant never fetched our metadata;
//                its IdP must import that metadata before the switch is on);
//                with the request store, its ID is persisted for correlation.
//   ACS          verifies the response — decrypts an encrypted assertion with
//                the same key when one exists, and checks InResponseTo against
//                the store (`ifPresent`, or `always` when the tenant opted in).
//
// One instance per request: SamlRequestStore remembers what THIS validation
// spent (see its header), which is exactly per-request state.

import type { SAML } from '@node-saml/node-saml';
import { samlForOrg, type OrgSamlConfig } from '@/lib/ssoSaml';
import { SamlRequestStore } from '@/lib/ssoSamlRequestStore';
import { ensureSpSigningKey, existingSpPrivateKey } from '@/lib/ssoSpKey';

export interface OrgSamlLoginConfig extends OrgSamlConfig {
  id: string;
  slug: string;
  ssoSpKey: string | null;
  ssoSpCert: string | null;
  ssoSignRequests: boolean;
  ssoRequireInResponseTo: boolean;
}

export async function samlLoginForOrg(slug: string, org: OrgSamlLoginConfig): Promise<SAML> {
  const spPrivateKeyPem = org.ssoSignRequests
    ? (await ensureSpSigningKey(org)).privateKeyPem
    : existingSpPrivateKey(org);
  return samlForOrg(slug, org, {
    spPrivateKeyPem,
    signRequests: org.ssoSignRequests,
    requestStore: new SamlRequestStore(org.id),
    requireInResponseTo: org.ssoRequireInResponseTo,
  });
}
