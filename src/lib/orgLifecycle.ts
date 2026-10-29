// The tenant lifecycle writer (#1580/#1582, docs/tenant-lifecycle.md). Server-only.
//
// The ONE place an organization's name, slug and archive state are written.
// The rule (what may change) is pure in src/lib/orgLifecycleRule.ts; who may
// ask is the route's `requirePermission('platform.org.write')`. Each write:
//
//   1. reads the row and asks the rule — never trusting a value from a body;
//   2. writes it (a slug collision answers `slug_taken`, never a 500);
//   3. records it through recordOrgWrite() — an ActivityLog entry and an
//      AuditLog row stamped with the TARGET org, naming old → new — and raises
//      `org.config.changed` with #1699's redacted diff, the same event the
//      PATCH /api/admin/organizations handler raises for plan/brand/SSO.
//
// The archive state is read by the mail gate through src/lib/orgArchive.ts
// (cached) and by every sign-in door fresh (src/lib/auth.ts).

import { prisma } from '@/lib/prisma';
import { recordOrgWrite } from '@/lib/orgAudit';
import { forgetOrgArchive } from '@/lib/orgArchive';
import { emit } from '@/lib/events/emit';
import { redactedDiff, ORGANIZATION_DIFF_SPEC } from '@/lib/events/diff';
import {
  archiveDecision,
  planRename,
  type ArchiveRefusal,
  type RenameRefusal,
} from '@/lib/orgLifecycleRule';

export interface LifecycleActor {
  id: string;
  email?: string | null;
  orgId: string | null;
}

const LIFECYCLE_SELECT = {
  id: true,
  name: true,
  slug: true,
  ssoEnabled: true,
  archivedAt: true,
  archivedById: true,
} as const;

type Refusal<C extends string> = { ok: false; code: C | 'not_found' };

async function audit(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  orgId: string,
  action: string,
  actor: LifecycleActor,
  detail: string,
  request?: Request,
  level?: 'info' | 'warning',
) {
  await recordOrgWrite({
    orgId,
    action,
    actorId: actor.id,
    actorEmail: actor.email ?? null,
    detail,
    level,
    request,
  });
  const changes = redactedDiff(before, after, ORGANIZATION_DIFF_SPEC);
  if (changes.length) {
    await emit('org.config.changed', { orgId, changes }, { orgId, actor: { id: actor.id, type: 'user' } });
  }
}

export type RenameResult =
  | { ok: true; organization: { id: string; name: string; slug: string } }
  | Refusal<RenameRefusal | 'slug_taken'>;

/** Rename an organization and/or change its slug. */
export async function renameOrganization(
  orgId: string,
  input: { name?: string | null; slug?: string | null; force?: boolean },
  actor: LifecycleActor,
  request?: Request,
): Promise<RenameResult> {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: LIFECYCLE_SELECT });
  if (!org) return { ok: false, code: 'not_found' };
  const plan = planRename(org, input);
  if (!plan.ok) return plan;

  if (plan.data.slug) {
    const clash = await prisma.organization.findFirst({
      where: { slug: plan.data.slug, NOT: { id: orgId } },
      select: { id: true },
    });
    if (clash) return { ok: false, code: 'slug_taken' };
  }

  let updated;
  try {
    updated = await prisma.organization.update({
      where: { id: orgId },
      data: plan.data,
      select: { id: true, name: true, slug: true },
    });
  } catch (e) {
    // The unique index is the real arbiter: two renames racing for one slug.
    if ((e as { code?: string }).code === 'P2002') return { ok: false, code: 'slug_taken' };
    throw e;
  }

  const parts: string[] = [];
  if (plan.data.name !== undefined) parts.push(`name: "${org.name}" → "${updated.name}"`);
  if (plan.slugChanged) parts.push(`slug: ${org.slug} → ${updated.slug}`);
  if (plan.forcedSso) parts.push('FORCED while SSO is enabled — the IdP must use the new Entity ID / ACS URL');
  await audit(
    { name: org.name, slug: org.slug },
    { name: updated.name, slug: updated.slug },
    orgId,
    'org.renamed',
    actor,
    parts.join('; '),
    request,
    plan.forcedSso ? 'warning' : 'info',
  );
  return { ok: true, organization: updated };
}

export type ArchiveResult =
  | { ok: true; archivedAt: Date | null }
  | Refusal<ArchiveRefusal>;

/** Archive (`true`) or bring back (`false`) an organization. Destroys nothing. */
export async function setOrganizationArchived(
  orgId: string,
  archive: boolean,
  actor: LifecycleActor,
  request?: Request,
): Promise<ArchiveResult> {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: LIFECYCLE_SELECT });
  if (!org) return { ok: false, code: 'not_found' };
  const decision = archiveDecision(org, archive, actor.orgId);
  if (!decision.ok) return decision;

  const archivedAt = archive ? new Date() : null;
  // Guarded on the state just read: of two operators pressing the same
  // button, one writes and the other is told it already happened.
  const { count } = await prisma.organization.updateMany({
    where: { id: orgId, archivedAt: archive ? null : { not: null } },
    data: { archivedAt, archivedById: archive ? actor.id : null },
  });
  forgetOrgArchive(orgId);
  if (count === 0) return { ok: false, code: archive ? 'already_archived' : 'not_archived' };

  await audit(
    { archivedAt: org.archivedAt },
    { archivedAt },
    orgId,
    archive ? 'org.archived' : 'org.unarchived',
    actor,
    archive
      ? `archived "${org.name}" (${org.slug}): sign-in and mail stopped, data kept`
      : `unarchived "${org.name}" (${org.slug}); was archived ${org.archivedAt?.toISOString() ?? '?'}`,
    request,
    'warning',
  );
  return { ok: true, archivedAt };
}
