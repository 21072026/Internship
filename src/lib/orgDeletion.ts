// Tenant hard delete — the gated server half (#1584, docs/tenant-lifecycle.md
// § Hard delete). Server-only. The locks are pure in src/lib/orgDeletionRule.ts;
// the deletion itself is src/lib/orgDeletionExec.ts. Who may ask is the
// route's `requirePermission('platform.org.write')`.
//
// AUDIT THAT OUTLIVES THE DATA. Everything stamped with the deleted org goes
// with it — its ActivityLog and AuditLog rows included. So the `org.deleted`
// record is written BEFORE the transaction and stamped with the OPERATOR's org,
// naming the tenant's id, slug and name; a failed run adds `org.delete_failed`
// next to it. The request and its withdrawal are ordinary tenant audit rows.

import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { logger } from '@/lib/logger';
import { recordOrgWrite } from '@/lib/orgAudit';
import { forgetOrgArchive } from '@/lib/orgArchive';
import { runWithOrg } from '@/lib/orgContext';
import {
  executeDecision,
  hardDeleteEnabled,
  requestDecision,
  waitHours,
  type DeletionRefusal,
} from '@/lib/orgDeletionRule';
import { deleteTenantRows, type DeletionResult } from '@/lib/orgDeletionExec';

export interface DeletionActor {
  id: string;
  email?: string | null;
  orgId: string | null;
}

const SELECT = { id: true, slug: true, name: true, archivedAt: true, deletionRequestedAt: true } as const;

type Refused = { ok: false; code: DeletionRefusal | 'not_found' | 'password_incorrect' };

export function hardDeleteConfig() {
  return { enabled: hardDeleteEnabled(process.env), waitHours: waitHours(process.env) };
}

/** Stage 1 — request the deletion of an archived tenant (typed slug). */
export async function requestOrgDeletion(
  orgId: string,
  confirmSlug: string,
  actor: DeletionActor,
  request?: Request,
): Promise<{ ok: true; deletionRequestedAt: Date } | Refused> {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: SELECT });
  if (!org) return { ok: false, code: 'not_found' };
  const d = requestDecision(org, { enabled: hardDeleteConfig().enabled, actorOrgId: actor.orgId, confirmSlug });
  if (!d.ok) return d;
  const at = new Date();
  const { count } = await prisma.organization.updateMany({
    where: { id: orgId, deletionRequestedAt: null, archivedAt: { not: null } },
    data: { deletionRequestedAt: at, deletionRequestedById: actor.id },
  });
  if (count === 0) return { ok: false, code: 'already_requested' };
  await recordOrgWrite({
    orgId,
    action: 'org.deletion_requested',
    actorId: actor.id,
    actorEmail: actor.email ?? null,
    level: 'warning',
    detail: `permanent deletion of "${org.name}" (${org.slug}) requested; executable after ${hardDeleteConfig().waitHours}h and a fresh export`,
    request,
  });
  return { ok: true, deletionRequestedAt: at };
}

/** Withdraw a pending request. */
export async function cancelOrgDeletion(orgId: string, actor: DeletionActor, request?: Request): Promise<{ ok: true } | Refused> {
  if (!hardDeleteConfig().enabled) return { ok: false, code: 'hard_delete_disabled' };
  const { count } = await prisma.organization.updateMany({
    where: { id: orgId, deletionRequestedAt: { not: null } },
    data: { deletionRequestedAt: null, deletionRequestedById: null },
  });
  if (count === 0) {
    const exists = await prisma.organization.count({ where: { id: orgId } });
    return { ok: false, code: exists ? 'not_requested' : 'not_found' };
  }
  await recordOrgWrite({
    orgId,
    action: 'org.deletion_cancelled',
    actorId: actor.id,
    actorEmail: actor.email ?? null,
    level: 'warning',
    detail: 'permanent deletion request withdrawn',
    request,
  });
  return { ok: true };
}

async function operatorAudit(actor: DeletionActor, action: string, detail: string, request?: Request) {
  try {
    await prisma.auditLog.create({
      data: { orgId: actor.orgId, actorId: actor.id, action, targetId: null, detail },
    });
  } catch (e) {
    logger.error('Failed to persist org deletion audit row', { action, error: String(e) });
  }
  await logActivity({
    action,
    level: 'warning',
    actorId: actor.id,
    actorEmail: actor.email ?? null,
    targetType: 'organization',
    detail,
    request,
    orgId: actor.orgId,
  });
}

/** Stage 2 — run the requested deletion (typed slug + the operator's own password). */
export async function executeOrgDeletion(
  orgId: string,
  input: { confirmSlug: string; password: string },
  actor: DeletionActor,
  request?: Request,
): Promise<{ ok: true; result: DeletionResult } | Refused> {
  const cfg = hardDeleteConfig();
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: SELECT });
  if (!org) return { ok: false, code: 'not_found' };

  const exportedSinceRequest = org.deletionRequestedAt
    ? (await prisma.auditLog.count({
        where: { orgId, action: 'org.exported', createdAt: { gte: org.deletionRequestedAt } },
      })) > 0
    : false;
  const d = executeDecision(org, {
    enabled: cfg.enabled,
    actorOrgId: actor.orgId,
    confirmSlug: input.confirmSlug,
    now: new Date(),
    waitHours: cfg.waitHours,
    exportedSinceRequest,
  });
  if (!d.ok) return d;

  // Step-up: the operator's own password, as the user erasure route asks.
  const me = await prisma.user.findUnique({ where: { id: actor.id }, select: { password: true } });
  if (!me || !(await bcrypt.compare(input.password, me.password))) return { ok: false, code: 'password_incorrect' };

  const what = `organization ${org.id} "${org.name}" (${org.slug}); requested ${org.deletionRequestedAt?.toISOString()}`;
  await operatorAudit(actor, 'org.deleted', `permanently deleting ${what}`, request);
  try {
    const result = await runWithOrg(orgId, () => deleteTenantRows(prisma, orgId));
    forgetOrgArchive(orgId);
    const total = Object.values(result.deleted).reduce((a, b) => a + b, 0);
    logger.warning('Tenant permanently deleted', { orgId, rows: total, nulled: result.nulled });
    return { ok: true, result };
  } catch (e) {
    await operatorAudit(actor, 'org.delete_failed', `deletion rolled back for ${what}: ${String(e).slice(0, 500)}`, request);
    throw e;
  }
}
