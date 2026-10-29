// Organization columns that are credentials. They are read on the server and
// never sent to a browser, whoever asks: a super admin editing an org needs the
// SP certificate (it is published in the metadata anyway), never the sealed
// private half of our SP signing key (#1952, src/lib/ssoSpKey.ts).
//
// Every route that answers with an Organization row it did not `select`
// field by field passes it through withoutOrgCredentials(). A new credential
// column goes in this list, and e2e/admin-organizations.spec.ts asserts that
// none of them reaches a response.
// The sealed OIDC client secret (#1926) is one too.
export const ORG_CREDENTIAL_FIELDS = ['ssoSpKey', 'ssoClientSecretEnc'] as const;

type CredentialField = (typeof ORG_CREDENTIAL_FIELDS)[number];

export function withoutOrgCredentials<T extends object>(org: T): Omit<T, CredentialField> {
  const copy = { ...org } as Record<string, unknown>;
  for (const field of ORG_CREDENTIAL_FIELDS) delete copy[field];
  return copy as Omit<T, CredentialField>;
}
