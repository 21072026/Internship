// The tenant hard-delete rule (#1584, docs/tenant-lifecycle.md § Hard delete).
// Pure and dependency-free; unit-tested against the real schema
// (scripts/test/org-deletion-rule.test.mjs). The server half is
// src/lib/orgDeletion.ts.
//
// IRREVERSIBLE, SO FOUR LOCKS, ALL REQUIRED:
//   1. the deployment switch `TENANT_HARD_DELETE_ENABLED=1` — OFF unless set,
//      and nothing in the repository sets it;
//   2. the tenant is ARCHIVED (no one-click destroy of a live tenant);
//   3. TWO STAGES: a deletion request (typed slug) and, no sooner than
//      `TENANT_HARD_DELETE_WAIT_HOURS` later (default 72, never under 24), the
//      execution (typed slug + the operator's own password) — with a full
//      export taken after the request;
//   4. never the `default` org, never the operator's own org.
//
// WHAT IS DELETED is planned from the schema, not hand-listed and never left to
// `db push` or to `onDelete` cascades: `planDeletion()` takes every model with
// this org's `orgId`, then every model WITHOUT an orgId that hangs off those
// rows by a single-column foreign key (it has no owner of its own, so it is the
// tenant's), to a fixed point. Every optional link into the deleted set is
// nulled first — for a row of ANOTHER org that merely points here that is the
// only change it sees; for a row about to go it frees the order. The deletes
// then run children-first in a topological order of the required links. A shape the plan cannot handle (a
// cycle of required links) is a plan error, and the unit test runs the plan on
// the real schema so it surfaces in CI, not on a customer's tenant.

import { DEFAULT_ORG_SLUG } from './orgLifecycleRule';

export const HARD_DELETE_FLAG = 'TENANT_HARD_DELETE_ENABLED';
export const HARD_DELETE_WAIT_FLAG = 'TENANT_HARD_DELETE_WAIT_HOURS';
export const DEFAULT_WAIT_HOURS = 72;
export const MIN_WAIT_HOURS = 24;

type Env = Readonly<Record<string, string | undefined>>;

/** OFF unless the deployment says exactly `1` / `true`. */
export function hardDeleteEnabled(env: Env): boolean {
  const v = env[HARD_DELETE_FLAG]?.trim().toLowerCase();
  return v === '1' || v === 'true';
}

/** The cooling-off period between request and execution, in hours (floored at MIN_WAIT_HOURS). */
export function waitHours(env: Env): number {
  const n = Number(env[HARD_DELETE_WAIT_FLAG]);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_WAIT_HOURS;
  return Math.max(MIN_WAIT_HOURS, Math.floor(n));
}

export interface DeletionOrg {
  id: string;
  slug: string;
  archivedAt: Date | string | null;
  deletionRequestedAt: Date | string | null;
}

export type DeletionRefusal =
  | 'hard_delete_disabled'
  | 'default_org'
  | 'own_org'
  | 'not_archived'
  | 'slug_mismatch'
  | 'already_requested'
  | 'not_requested'
  | 'waiting_period'
  | 'export_required';

type Decision = { ok: true } | { ok: false; code: DeletionRefusal };

function common(org: DeletionOrg, enabled: boolean, actorOrgId: string | null, confirmSlug: string): Decision | null {
  if (!enabled) return { ok: false, code: 'hard_delete_disabled' };
  if (org.slug === DEFAULT_ORG_SLUG) return { ok: false, code: 'default_org' };
  if (actorOrgId !== null && actorOrgId === org.id) return { ok: false, code: 'own_org' };
  if (!org.archivedAt) return { ok: false, code: 'not_archived' };
  if (confirmSlug.trim() !== org.slug) return { ok: false, code: 'slug_mismatch' };
  return null;
}

/** Stage 1: may a deletion be requested? */
export function requestDecision(org: DeletionOrg, input: { enabled: boolean; actorOrgId: string | null; confirmSlug: string }): Decision {
  const refused = common(org, input.enabled, input.actorOrgId, input.confirmSlug);
  if (refused) return refused;
  if (org.deletionRequestedAt) return { ok: false, code: 'already_requested' };
  return { ok: true };
}

/** Stage 2: may the requested deletion run now? The password is checked by the caller. */
export function executeDecision(
  org: DeletionOrg,
  input: { enabled: boolean; actorOrgId: string | null; confirmSlug: string; now: Date; waitHours: number; exportedSinceRequest: boolean },
): Decision {
  const refused = common(org, input.enabled, input.actorOrgId, input.confirmSlug);
  if (refused) return refused;
  if (!org.deletionRequestedAt) return { ok: false, code: 'not_requested' };
  const eligible = new Date(org.deletionRequestedAt).getTime() + input.waitHours * 3_600_000;
  if (input.now.getTime() < eligible) return { ok: false, code: 'waiting_period' };
  if (!input.exportedSinceRequest) return { ok: false, code: 'export_required' };
  return { ok: true };
}

/** When the request becomes executable. */
export function eligibleAt(org: Pick<DeletionOrg, 'deletionRequestedAt'>, hours: number): Date | null {
  return org.deletionRequestedAt ? new Date(new Date(org.deletionRequestedAt).getTime() + hours * 3_600_000) : null;
}

// ── The plan ────────────────────────────────────────────────────────────────

export interface SchemaModel {
  name: string;
  hasOrgId: boolean;
  /** FK edges FROM this model: its scalar column(s), the target model, the target column(s), and whether the link is required. */
  links: readonly { model: string; fields: readonly string[]; references: readonly string[]; required: boolean }[];
}

export interface DeleteStep {
  model: string;
  /** `org` = `where: { orgId }`; otherwise the required links to deleted parents (rows match ANY of them). */
  where: 'org' | { field: string; parent: string; parentKey: string }[];
}

export interface NullifyStep {
  model: string;
  field: string;
  parent: string;
  parentKey: string;
}

export interface DeletionPlan {
  /** Children first; Organization itself is deleted after the last step. */
  deletes: DeleteStep[];
  /** Optional links into the deleted set, nulled before any delete. */
  nullify: NullifyStep[];
  /** Multi-column links into the deleted set — the plan does not follow them; listed so the test can pin there are none. */
  unhandled: string[];
}

/**
 * Columns that hold a row id WITHOUT a declared relation (no foreign key, so
 * the schema walk cannot see them). Each is a bearer grant minted for a person;
 * a deleted tenant's people leave none behind.
 */
export const SOFT_LINKS: readonly { model: string; field: string; parent: string; parentKey: string }[] = Object.freeze([
  { model: 'ImpersonationGrant', field: 'targetId', parent: 'User', parentKey: 'id' },
  { model: 'ImpersonationGrant', field: 'adminId', parent: 'User', parentKey: 'id' },
  { model: 'SsoLoginGrant', field: 'userId', parent: 'User', parentKey: 'id' },
  { model: 'SessionRefreshGrant', field: 'userId', parent: 'User', parentKey: 'id' },
]);

export function planDeletion(models: readonly SchemaModel[], softLinks = SOFT_LINKS): DeletionPlan {
  const byName = new Map(models.map((m) => [m.name, m]));
  const where = new Map<string, DeleteStep['where']>();
  for (const m of models) if (m.hasOrgId && m.name !== 'Organization') where.set(m.name, 'org');
  // The org row itself is a parent too (models linked to Organization without an orgId column).
  const deleted = (name: string) => name === 'Organization' || where.has(name);

  for (let changed = true; changed; ) {
    changed = false;
    for (const m of models) {
      if (deleted(m.name)) continue;
      // A model without an orgId belongs to whatever it hangs off: a link into
      // the deleted set, required OR optional, makes the row the tenant's
      // (a Message whose relation is optional is still that relation's message).
      const via = m.links
        .filter((l) => deleted(l.model) && l.fields.length === 1 && l.references.length === 1)
        .map((l) => ({ field: l.fields[0], parent: l.model, parentKey: l.references[0] }));
      if (via.length) {
        where.set(m.name, via);
        changed = true;
      }
    }
  }

  // Soft links: no FK, so no order constraint — they go first.
  const soft = new Map<string, { field: string; parent: string; parentKey: string }[]>();
  for (const l of softLinks) {
    if (where.has(l.model) || !where.has(l.parent)) continue;
    soft.set(l.model, [...(soft.get(l.model) ?? []), { field: l.field, parent: l.parent, parentKey: l.parentKey }]);
  }

  const nullify: NullifyStep[] = [];
  const unhandled: string[] = [];
  for (const m of models) {
    for (const l of m.links) {
      if (!deleted(l.model)) continue;
      if (l.fields.length !== 1 || l.references.length !== 1) {
        if (!deleted(m.name) || l.required) unhandled.push(`${m.name}.(${l.fields.join(',')}) → ${l.model}`);
        continue;
      }
      // Never the ownership column itself: an org-scoped row is deleted BY its
      // orgId, and nulling it first would orphan the row into the default org
      // instead of deleting it.
      if (l.fields[0] === 'orgId' && where.get(m.name) === 'org') continue;
      if (!l.required) nullify.push({ model: m.name, field: l.fields[0], parent: l.model, parentKey: l.references[0] });
    }
  }

  // Topological order over REQUIRED links among deleted models: a child before its parent.
  const names = [...where.keys()];
  const deps = new Map<string, Set<string>>(); // model → parents it must be deleted before
  for (const n of names) {
    const ps = new Set<string>();
    for (const l of byName.get(n)!.links) {
      if (l.required && where.has(l.model) && l.model !== n) ps.add(l.model);
    }
    deps.set(n, ps);
  }
  // children-of map, then Kahn from the leaves (models nobody requires).
  const requiredBy = new Map<string, number>(names.map((n) => [n, 0]));
  for (const [, ps] of deps) for (const p of ps) requiredBy.set(p, (requiredBy.get(p) ?? 0) + 1);
  const ready = names.filter((n) => requiredBy.get(n) === 0).sort();
  const order: string[] = [];
  while (ready.length) {
    const n = ready.shift()!;
    order.push(n);
    for (const p of [...deps.get(n)!].sort()) {
      const left = requiredBy.get(p)! - 1;
      requiredBy.set(p, left);
      if (left === 0) ready.push(p);
    }
  }
  if (order.length !== names.length) {
    const stuck = names.filter((n) => !order.includes(n)).sort();
    throw new Error(`Deletion plan: a cycle of required links among ${stuck.join(', ')}`);
  }
  // A required self-link cannot be ordered by model; it must be optional (nulled) or absent.
  for (const n of names) {
    for (const l of byName.get(n)!.links) if (l.required && l.model === n) unhandled.push(`${n}.(${l.fields.join(',')}) → itself (required)`);
  }

  return {
    deletes: [...[...soft].map(([model, via]) => ({ model, where: via })), ...order.map((model) => ({ model, where: where.get(model)! }))],
    nullify,
    unhandled,
  };
}
