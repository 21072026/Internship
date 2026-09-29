// Who may read or change an org's document requirements (#2542).
//
// The document-requirement routes name the org explicitly (`?orgId=` / body
// `orgId`) because a super admin manages any tenant's requirements from the
// org picker in DocumentRequirementsAdmin (#1535). They are therefore NOT
// wrapped in withTenantScope, for the same reason as
// /api/admin/organizations/[id]/pipeline-stages: binding the caller's tenant
// would narrow a super admin to their own org. Every query there names its
// `orgId` itself, and this is the authorisation in front of it:
//
//   * a caller in the target org (or an org-less one, or a target that is not
//     known — `sameOrgOrUnknown`, the single-tenant state) passes as before;
//   * a super admin passes for any org;
//   * anyone else is refused, the refusal is audited, and the route answers
//     404 exactly as it does for an org that does not exist — a 403 would tell
//     another tenant that the id is real.
//
// SERVER-ONLY (isSuperAdmin reads the database).

import type { Session } from 'next-auth';
import { resolveOrgId, sameOrgOrUnknown } from '@/lib/orgScope';
import { isSuperAdmin, logCrossTenantDenial } from '@/lib/superAdmin';

export async function mayManageOrgRequirements(
  session: Session,
  targetOrgId: string,
  route: string,
): Promise<boolean> {
  if (sameOrgOrUnknown(targetOrgId, resolveOrgId(session))) return true;
  if (await isSuperAdmin(session)) return true;
  await logCrossTenantDenial(session, route, targetOrgId);
  return false;
}
