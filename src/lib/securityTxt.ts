/**
 * /.well-known/security.txt (RFC 9116, #2031) — built per request, not served
 * from public/.
 *
 * WHY A ROUTE AND NOT A STATIC FILE
 *   The file used to be a static `public/.well-known/security.txt` naming one
 *   channel: this repository's GitHub private vulnerability reporting. That is
 *   the right place for a report about the *code*, but a report about a
 *   deployment's *data* belongs to whoever runs that deployment — and this is
 *   AGPL software that other people run. The operator's address already comes
 *   from the deployment's environment (`OPERATOR_EMAIL`, src/lib/imprint.ts), so
 *   the second `Contact:` line follows it instead of a mailbox written into the
 *   source. A deployment with a dedicated security mailbox sets
 *   `SECURITY_CONTACT_EMAIL`, which wins over the general operator address.
 *
 * ORDER: RFC 9116 § 2.5.3 reads the first `Contact:` as preferred. The GitHub
 * advisory form stays first because the disclosure policy promises it
 * (docs/trust/vulnerability-disclosure.md § 1) and it provably reaches someone.
 *
 * RENEWAL: `SECURITY_TXT_EXPIRES` must stay under a year out (RFC 9116
 * § 2.5.5). e2e/security-txt.spec.ts fails when it is in the past or more than
 * a year away — that red run is the reminder: re-read the policy, confirm both
 * channels still reach someone, then move the date.
 *
 * `Canonical:` is deliberately absent: the same response is served on
 * production, preview, the marketing hosts and every per-PR environment, and a
 * canonical URI that disagrees with the host it was fetched from is worse than
 * none. Pure and dependency-free so the e2e unit spec can import it.
 */

export const SECURITY_TXT_EXPIRES = '2027-06-30T00:00:00.000Z';

const REPO = 'https://github.com/21072026/Internship';

/** A bare address that is safe to print after `mailto:` — nothing else. */
const PLAIN_EMAIL = /^[^\s@<>()"',;:\\]+@[^\s@<>()"',;:\\]+\.[^\s@<>()"',;:\\]+$/;

export function securityContactEmail(
  env: Record<string, string | undefined>,
  operatorEmail: string | null | undefined,
): string | null {
  for (const candidate of [env.SECURITY_CONTACT_EMAIL, operatorEmail]) {
    const v = candidate?.trim();
    // An env value is operator-controlled, but it is printed into a file
    // researchers' tools parse: a newline in it would forge a field.
    if (v && PLAIN_EMAIL.test(v)) return v;
  }
  return null;
}

export function buildSecurityTxt(contactEmail: string | null): string {
  const lines = [
    '# Security contact for this deployment (RFC 9116). Reports about the code',
    '# go to the GitHub advisory form; reports about this deployment\'s data may',
    '# also go to its operator. Policy: scope, safe harbour, response targets.',
    '',
    `Contact: ${REPO}/security/advisories/new`,
    ...(contactEmail ? [`Contact: mailto:${contactEmail}`] : []),
    `Expires: ${SECURITY_TXT_EXPIRES}`,
    'Preferred-Languages: en, tr, de',
    `Policy: ${REPO}/blob/main/docs/trust/vulnerability-disclosure.md`,
    `Acknowledgments: ${REPO}/blob/main/CHANGELOG.md`,
  ];
  return lines.join('\n') + '\n';
}
