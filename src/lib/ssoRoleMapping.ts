// IdP role mapping (#1940) — the rule, pure and dependency-free so
// `node --test --experimental-strip-types` loads it directly
// (scripts/test/sso-role-mapping.test.mjs).
//
// WHY: docs/sso-saml.md promised a user is provisioned "with a default
// least-privilege MENTEE, or an IdP-mapped role". The second half did not
// exist — the ACS route never passed a role — so a customer's programme staff
// signed in through their own IdP and landed in the mentee portal. A tenant now
// maps a claim value ("groups" contains "mentors") to a role.
//
// THE RULES, none of them negotiable:
//   1. No match is `null`, and the caller provisions MENTEE. Never guess upward.
//   2. Among matching mappings the highest `priority` wins; a tie goes to the
//      LESS privileged role. A misconfiguration therefore errs towards less
//      access, never more.
//   3. `ADMIN` is not mappable yet (MAPPABLE_ROLES). It is refused at the write
//      boundary and — belt and braces — ignored here, until the platform gate
//      (#1575) lands: mapping a claim to ADMIN turns any gap in who may edit an
//      org's SSO config into remote privilege escalation.
//   4. Claim values compare case-insensitively and trimmed; a claim NAME is
//      matched exactly (IdPs use URIs, and two different URIs are two claims).

export type SsoRole = 'MENTEE' | 'MENTOR' | 'ADMIN' | 'COMPANY' | 'SOURCE';

/** Least privileged first. The tie rule reads this order. */
export const ROLE_PRIVILEGE: readonly SsoRole[] = ['MENTEE', 'SOURCE', 'COMPANY', 'MENTOR', 'ADMIN'];

/** Roles a mapping may grant today. ADMIN waits for #1575 — see rule 3. */
export const MAPPABLE_ROLES: readonly SsoRole[] = ['MENTEE', 'SOURCE', 'COMPANY', 'MENTOR'];

export function isMappableRole(role: string): role is SsoRole {
  return (MAPPABLE_ROLES as readonly string[]).includes(role);
}

export interface ClaimMapping {
  claim: string;
  matchValue: string;
  role: string;
  priority: number;
}

export type SsoClaims = Record<string, string[]>;

const norm = (v: string) => v.trim().toLowerCase();

/**
 * Every attribute of a verified profile, as trimmed string arrays. node-saml
 * hands a multi-valued attribute over as an array and a single one as a plain
 * string — normalising both is what keeps a user in exactly one group from
 * silently matching nothing. Non-string values (the raw XML, issuer objects)
 * are dropped; empty strings too.
 */
export function extractClaims(profile: Record<string, unknown> | null | undefined): SsoClaims {
  const out: SsoClaims = {};
  if (!profile) return out;
  for (const [key, raw] of Object.entries(profile)) {
    const values = (Array.isArray(raw) ? raw : [raw])
      .filter((v): v is string => typeof v === 'string')
      .map((v) => v.trim())
      .filter(Boolean);
    if (values.length > 0) out[key] = values;
  }
  return out;
}

/** The role the mappings grant for these claims, or null (→ the caller's MENTEE). */
export function resolveRole(mappings: readonly ClaimMapping[], claims: SsoClaims): SsoRole | null {
  let best: { role: SsoRole; priority: number } | null = null;
  for (const m of mappings) {
    if (!isMappableRole(m.role)) continue;
    const values = claims[m.claim];
    if (!values || !values.some((v) => norm(v) === norm(m.matchValue))) continue;
    const better =
      !best ||
      m.priority > best.priority ||
      (m.priority === best.priority && ROLE_PRIVILEGE.indexOf(m.role) < ROLE_PRIVILEGE.indexOf(best.role));
    if (better) best = { role: m.role, priority: m.priority };
  }
  return best?.role ?? null;
}
