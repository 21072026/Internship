import { prisma } from '@/lib/prisma';
import { brandForOrg } from '@/lib/orgBrand';
import { clientBrandOf } from '@/lib/hostBrand';
import { hostVertical } from '@/lib/hostVertical';
import { worldOfOrg } from '@/lib/userWorld';
import type { ClientBrand } from '@/lib/brandRule';

// The brand an invitation's landing wears (#1663, docs/white-label.md): the
// inviting organization's, for a LIVE invitation of this host's world. Null for
// everything else — no token, an unknown, used, revoked or expired one, and one
// of the other world, which /api/register refuses exactly like an unknown token
// (docs/worlds.md) — so the page renders the request's own brand and a token's
// existence is never told apart from its absence.
//
// Looked up BY TOKEN with no tenant context bound, like /api/register and
// /api/invite/opened: the visitor has no session, and the token is the only
// thing they hold. Only the brand leaves this function — nothing about the
// invitation itself. A database error is the default brand: a public page must
// render.
//
// SERVER-ONLY (Prisma, request headers).
export async function invitationBrand(token: string | null | undefined): Promise<ClientBrand | null> {
  if (!token || token.length > 200) return null;
  try {
    const invitation = await prisma.invitationToken.findUnique({
      where: { token },
      select: { orgId: true, used: true, revokedAt: true, expiresAt: true },
    });
    if (!invitation?.orgId || invitation.used || invitation.revokedAt || invitation.expiresAt <= new Date()) return null;
    if ((await worldOfOrg(invitation.orgId)) !== (await hostVertical())) return null;
    return clientBrandOf(await brandForOrg(invitation.orgId));
  } catch {
    return null;
  }
}
