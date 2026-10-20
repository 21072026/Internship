import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { logActivity, type ActivityInput } from '@/lib/activity';

// The audit trail of a write to an ORGANIZATION's own configuration (#1575):
// plan, vertical, branding, SSO, pipeline stages, conferencing, role mappings,
// the starter pack, an admin invitation, the organization's creation.
//
// Two rows, both stamped with the TARGET organization, never the actor's:
//
//   * an `AuditLog` row, so the tenant's audit drain (docs/audit-stream.md)
//     sees the change made to it — the drain reads `where: { orgId }` and a
//     row without one reaches nobody;
//   * the `ActivityLog` entry, with `orgId` passed explicitly. Left to
//     resolveActivityOrg() it falls back to the ACTOR's org, so a super admin
//     configuring tenant B filed the entry under its own home org — and the
//     creation of a new tenant put that customer's name and first admin's
//     address into a feed the operator org's other admins can read.
//
// `detail` goes to both rows and to the tenant's SIEM: name WHICH fields
// changed, never a certificate, a secret, a token or an SSO value.
//
// Called after the write committed. Never throws: an audit row that fails must
// not turn a committed change into a 500 the admin would retry — the failure
// is logged at error level instead, which is what the alerting reads.

export interface OrgWriteAudit {
  /** The organization written to — the row's tenant. */
  orgId: string;
  /** Dotted action, the same string on both rows (e.g. `org.updated`). */
  action: string;
  actorId: string | null | undefined;
  actorEmail?: string | null;
  level?: ActivityInput['level'];
  /** Defaults to the organization itself. */
  targetType?: string;
  targetId?: string;
  detail?: string | null;
  /** The AuditLog row's detail when it must say less than the activity entry (an address). */
  auditDetail?: string | null;
  request?: ActivityInput['request'];
}

export async function recordOrgWrite(input: OrgWriteAudit): Promise<void> {
  const targetType = input.targetType ?? 'organization';
  const targetId = input.targetId ?? input.orgId;
  try {
    await prisma.auditLog.create({
      data: {
        orgId: input.orgId,
        // A sessionless writer (none today) is the system, as in the sweeps.
        actorId: input.actorId || 'system',
        action: input.action,
        targetId,
        detail: (input.auditDetail !== undefined ? input.auditDetail : input.detail) ?? null,
      },
    });
  } catch (e) {
    logger.error('Failed to persist org audit row', { action: input.action, orgId: input.orgId, error: String(e) });
  }
  await logActivity({
    action: input.action,
    level: input.level,
    actorId: input.actorId ?? null,
    actorEmail: input.actorEmail ?? null,
    targetType,
    targetId,
    detail: input.detail ?? null,
    request: input.request,
    orgId: input.orgId,
  });
}
