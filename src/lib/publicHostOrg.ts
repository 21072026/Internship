// Host → tenant for SESSIONLESS public forms (#2569) — the database half.
//
// The rule itself (mapping → default org on an internship host → closed on an
// unmapped marketing host) is pure and unit-tested in ./publicHostRule.ts. This
// file only reads the two inputs it needs: which org claims the hostname
// (`Organization.publicHost`, exact match) and the default org.
//
// TRUST. This is the second permitted authz-adjacent use of the host signal (the
// first is /api/register's refusal, #2501) and it is recorded in the trust note
// of src/lib/hostVertical.ts. It decides only WHICH tenant's inbox a brand-new,
// unauthenticated enquiry is filed into. It never decides what anybody may READ:
// the answer carries no data out, and the page that renders the form shows the
// same text whichever org is resolved. So a forged X-Forwarded-Host — which
// Caddy overwrites in every environment anyway — can at worst put the forger's
// OWN enquiry into another tenant's queue, where that tenant's staff see a
// stranger's demo request. That is spam, not disclosure, and the same bucket
// rate limit applies to it.

import { prisma } from '@/lib/prisma';
import { defaultOrgId } from '@/lib/defaultOrg';
import { toVerticalKey } from '@/lib/verticals';
import { hostnameOf, verticalForHost } from '@/lib/hostVertical';
import { decidePublicInquiryTarget, type PublicInquiryTarget } from '@/lib/publicHostRule';

export type { PublicInquiryTarget } from '@/lib/publicHostRule';

/** The Host signal a public request carries: X-Forwarded-Host first, then Host. */
export function requestHostHeader(headers: Headers): string | null {
  return headers.get('x-forwarded-host') ?? headers.get('host');
}

/**
 * The tenant a public enquiry arriving on `hostHeader` belongs to, or a closed
 * answer. Never throws for a missing mapping — a closed form is an answer.
 */
export async function resolvePublicInquiryTarget(
  hostHeader: string | null | undefined,
): Promise<PublicInquiryTarget & { host: string | null }> {
  const host = hostnameOf(hostHeader);
  const hostVertical = verticalForHost(hostHeader);
  // `Organization` is not a tenant model, so this lookup is never rewritten by
  // the middleware; the exact-match `where` is the whole rule.
  const mapped = host
    ? await prisma.organization.findUnique({ where: { publicHost: host }, select: { id: true, vertical: true } })
    : null;
  // The default org is only ever the answer for an unmapped INTERNSHIP host, so
  // it is not looked up (or created) for any other case.
  const needsDefault = !mapped && hostVertical === 'INTERNSHIP';
  const target = decidePublicInquiryTarget({
    hostVertical,
    mapped: mapped ? { id: mapped.id, vertical: toVerticalKey(mapped.vertical) } : null,
    defaultOrgId: needsDefault ? await defaultOrgId() : null,
  });
  return { ...target, host };
}
