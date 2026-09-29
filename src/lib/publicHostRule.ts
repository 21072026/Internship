// Which tenant a SESSIONLESS public form writes into — the pure rule (#2569).
//
// ZERO imports on purpose, so `node --test --experimental-strip-types` can load
// it (scripts/test/public-host-org.test.mjs) and the rule is pinned without a
// database. The Prisma half — looking the mapping up — is src/lib/publicHostOrg.ts.
//
// THE RULE, in the order it is applied:
//
//   1. An org whose `Organization.publicHost` is EXACTLY the request's hostname
//      (lowercase, port dropped, no wildcard, no suffix match — the
//      servedHosts.ts rule) is the target, provided it is the same product the
//      host serves. A mapping that points a marketing host at an internship
//      tenant (or the reverse) is a configuration error, and the form CLOSES
//      rather than showing one product's page and filing into the other's inbox.
//   2. No mapping, INTERNSHIP host → the default org. This is what the form has
//      always done (#1559) and what `/api/register` does for an uninvited
//      sign-up; the internship product has one tenant per deployment today.
//   3. No mapping, MARKETING host → CLOSED. Never "the first MARKETING org", and
//      never the default org: the default org is the internship tenant, and an
//      enquiry filed there is read by the wrong company's staff. The form says
//      "not available right now" and the API answers 503.
//
// Why a column and not an env var (the issue left the choice open): the value
// being mapped TO is a database id, so an env map would have to carry a cuid
// copied by hand into each environment's secrets and a redeploy to change it,
// and nothing would stop one host being listed twice. `publicHost @unique` makes
// "one host, one tenant" a constraint of the database rather than a convention.

/** The two verticals, spelled out so this module needs no import. */
export type PublicHostVertical = 'INTERNSHIP' | 'MARKETING';

export type PublicInquiryTarget =
  | { open: true; orgId: string | null; vertical: PublicHostVertical; via: 'mapping' | 'default' }
  | { open: false; reason: 'unmapped_marketing_host' | 'vertical_mismatch'; vertical: PublicHostVertical };

/**
 * Normalise a value an OPERATOR types as a public host (the set-public-host
 * script, a seed). Returns the bare lowercase hostname, or null when the value
 * is not a plain hostname — a scheme, a path, a port, a wildcard or whitespace
 * inside is refused rather than stripped, so a mistyped mapping fails loudly
 * instead of silently matching nothing.
 */
export function normalizePublicHost(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const host = value.trim().toLowerCase();
  if (!host || host.length > 253) return null;
  // Labels of letters, digits and inner hyphens, dot-separated. No '*', no ':',
  // no '/', no trailing dot.
  const label = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
  return new RegExp(`^${label}(?:\\.${label})*$`).test(host) ? host : null;
}

/**
 * Decide the target from the host's vertical, the mapped org (if any) and the
 * default org. Pure: every input is resolved by the caller.
 */
export function decidePublicInquiryTarget(input: {
  hostVertical: PublicHostVertical;
  mapped: { id: string; vertical: PublicHostVertical } | null;
  defaultOrgId: string | null;
}): PublicInquiryTarget {
  const { hostVertical, mapped } = input;
  if (mapped) {
    if (mapped.vertical !== hostVertical) {
      return { open: false, reason: 'vertical_mismatch', vertical: hostVertical };
    }
    return { open: true, orgId: mapped.id, vertical: hostVertical, via: 'mapping' };
  }
  if (hostVertical === 'MARKETING') {
    return { open: false, reason: 'unmapped_marketing_host', vertical: hostVertical };
  }
  return { open: true, orgId: input.defaultOrgId, vertical: hostVertical, via: 'default' };
}
