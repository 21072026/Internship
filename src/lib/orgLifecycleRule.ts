// The tenant lifecycle rule (#1580, docs/tenant-lifecycle.md): may this
// organization be renamed, re-slugged, archived or brought back? Pure,
// dependency-free and unit-tested (scripts/test/org-lifecycle-rule.test.mjs);
// the server half that reads and writes the row is src/lib/orgLifecycle.ts.
//
// WHO is not decided here — every lifecycle write is `platform.org.write`
// (the per-world super admin, src/lib/authz.ts). This file decides WHAT, for
// a caller already allowed to ask.
//
// Three rows are protected by name, not by flag:
//   * the `default` organization: src/lib/defaultOrg.ts finds it by its slug,
//     so renaming that slug would make the next upsert mint a second, empty
//     default org; archiving it would lock out every legacy (orgId NULL →
//     default) account at once;
//   * the actor's OWN organization: a super admin archiving the tenant it signs
//     in through would end its own session with nobody left to undo it;
//   * an SSO-enabled tenant's slug: the SAML Entity ID and ACS URL hang off it
//     (src/lib/ssoSaml.ts), so a new slug breaks the customer's configured IdP.
//     Refused unless the operator says `force` (and the forced case is audited
//     as such by the caller).

import { slugifyOrg } from './orgSlug';

export const DEFAULT_ORG_SLUG = 'default';
export const ORG_NAME_MAX = 120;

export interface LifecycleOrg {
  id: string;
  name: string;
  slug: string;
  ssoEnabled: boolean;
  archivedAt: Date | string | null;
}

export type RenameRefusal =
  | 'nothing_to_change'
  | 'name_invalid'
  | 'slug_invalid'
  | 'default_org_slug'
  | 'sso_slug_locked'
  | 'archived';

export type RenamePlan =
  | { ok: true; data: { name?: string; slug?: string }; slugChanged: boolean; forcedSso: boolean }
  | { ok: false; code: RenameRefusal };

/**
 * What a rename request would write. `slugTaken` is NOT answered here (it
 * needs the database); the caller checks it for `data.slug` and answers 409.
 */
export function planRename(
  org: LifecycleOrg,
  input: { name?: string | null; slug?: string | null; force?: boolean },
): RenamePlan {
  if (org.archivedAt) return { ok: false, code: 'archived' };
  const data: { name?: string; slug?: string } = {};

  if (input.name != null) {
    const name = input.name.trim();
    if (!name || name.length > ORG_NAME_MAX) return { ok: false, code: 'name_invalid' };
    if (name !== org.name) data.name = name;
  }

  let slugChanged = false;
  let forcedSso = false;
  if (input.slug != null) {
    const slug = slugifyOrg(input.slug);
    if (!slug) return { ok: false, code: 'slug_invalid' };
    if (slug !== org.slug) {
      if (org.slug === DEFAULT_ORG_SLUG) return { ok: false, code: 'default_org_slug' };
      if (org.ssoEnabled) {
        if (!input.force) return { ok: false, code: 'sso_slug_locked' };
        forcedSso = true;
      }
      data.slug = slug;
      slugChanged = true;
    }
  }

  if (data.name === undefined && data.slug === undefined) return { ok: false, code: 'nothing_to_change' };
  return { ok: true, data, slugChanged, forcedSso };
}

export type ArchiveRefusal = 'default_org' | 'own_org' | 'already_archived' | 'not_archived';

/** May `org` be archived (`archive: true`) or brought back (`false`) by an actor of `actorOrgId`? */
export function archiveDecision(
  org: Pick<LifecycleOrg, 'id' | 'slug' | 'archivedAt'>,
  archive: boolean,
  actorOrgId: string | null,
): { ok: true } | { ok: false; code: ArchiveRefusal } {
  if (!archive) return org.archivedAt ? { ok: true } : { ok: false, code: 'not_archived' };
  if (org.archivedAt) return { ok: false, code: 'already_archived' };
  if (org.slug === DEFAULT_ORG_SLUG) return { ok: false, code: 'default_org' };
  if (actorOrgId !== null && actorOrgId === org.id) return { ok: false, code: 'own_org' };
  return { ok: true };
}

/** An archived tenant is closed: no sign-in, no mail. One predicate so every door reads the same thing. */
export function isArchived(org: { archivedAt: Date | string | null } | null | undefined): boolean {
  return Boolean(org?.archivedAt);
}
