// The one typed accessor for settings (#1619).
//
// `resolveSetting(key, scope?)` answers "what is this setting, here, for this
// programme" with a PARSED value — `14`, not `'14'` — through the chain written
// once in `pickSetting()` (src/lib/settings.ts):
//
//   programme row → org row → global row → SETTING_DEFAULTS
//
// Scope: `{ orgId?, programId? }`. An omitted `orgId` resolves exactly as the
// string readers do (`settingOrgId()`: the org bound by `withTenantScope()`, or
// the global layer when none is bound), so a zero-argument call keeps meaning
// what it meant. `programId` is never guessed; a caller holding a relation or a
// programme gets both ids from `resolveProgramScope()` in one query.
//
// COST: every key of one scope is loaded by ONE query (`settingRowsQuery`) and
// memoised for the rest of the request — the request context's memo
// (`withRequestScope`), or `withSettingsCache(fn)` for a cron or job that has
// no request. A sweep reading `reminderDays` for three hundred relations of one
// programme issues one query, not three hundred. Outside both, nothing is
// cached and every call is its own query, which is correct, just slower. The
// memo drops itself whenever `writeSetting()` has written since it was filled.
//
// SERVER-ONLY: it imports the request and tenant contexts (node:async_hooks)
// and Prisma. A client-reachable module reads the pure half in settings.ts.

import { AsyncLocalStorage } from 'node:async_hooks';
import { prisma } from '@/lib/prisma';
import { requestMemo } from '@/lib/requestContext';
import { runUnscoped } from '@/lib/tenantAmbient';
import { settingsOrgOfRow } from '@/lib/settingsOrg';
import {
  SETTING_DEFAULTS,
  parseSettingValue,
  pickSetting,
  settingOrgId,
  settingRowsQuery,
  settingsWriteGeneration,
  type ResolvedScope,
  type SettingKey,
  type SettingRow,
  type SettingSource,
  type SettingValue,
} from '@/lib/settings';

export type SettingsScope = { orgId?: string | null; programId?: string | null };

type CacheEntry = { generation: number; rows: Promise<SettingRow[]> };
type Cache = Map<string, CacheEntry>;

const MEMO_KEY = 'settings';
const jobCache = new AsyncLocalStorage<Cache>();

/**
 * Run `fn` with a settings cache bound — for a cron or job, which has no
 * request context to hang one on. Nesting is a no-op: the outer cache wins.
 */
export function withSettingsCache<T>(fn: () => T): T {
  if (jobCache.getStore()) return fn();
  return jobCache.run(new Map(), fn);
}

function boundCache(): Cache | undefined {
  const job = jobCache.getStore();
  if (job) return job;
  const memo = requestMemo();
  if (!memo) return undefined;
  let cache = memo.get(MEMO_KEY) as Cache | undefined;
  if (!cache) {
    cache = new Map();
    memo.set(MEMO_KEY, cache);
  }
  return cache;
}

function scopeOf(scope?: SettingsScope): ResolvedScope {
  const orgId = settingOrgId(scope?.orgId);
  // A programme only exists inside an org; without one the layer is unreachable.
  return { orgId, programId: orgId ? (scope?.programId ?? null) : null };
}

function loadRows(scope: ResolvedScope): Promise<SettingRow[]> {
  const query = () => runUnscoped(() => prisma.setting.findMany(settingRowsQuery(scope)));
  const cache = boundCache();
  if (!cache) return query();
  const key = `${scope.orgId ?? ''}\u0000${scope.programId ?? ''}`;
  const generation = settingsWriteGeneration();
  const hit = cache.get(key);
  if (hit && hit.generation === generation) return hit.rows;
  const rows = query();
  cache.set(key, { generation, rows });
  // A failed load must not be served from the cache for the rest of the request.
  rows.catch(() => {
    if (cache.get(key)?.rows === rows) cache.delete(key);
  });
  return rows;
}

/** One setting, parsed to its type, for `scope` (default: the bound org). */
export async function resolveSetting<K extends SettingKey>(key: K, scope?: SettingsScope): Promise<SettingValue<K>> {
  const resolved = scopeOf(scope);
  return parseSettingValue(key, pickSetting(await loadRows(resolved), key, resolved).raw);
}

/**
 * One setting as its stored string, through the same chain and cache — for a
 * reader whose own rule module parses it (a clamp, a list, a JSON document).
 */
export async function resolveSettingRaw(key: SettingKey, scope?: SettingsScope): Promise<string> {
  const resolved = scopeOf(scope);
  return pickSetting(await loadRows(resolved), key, resolved).raw;
}

export type ResolvedSettings = {
  values: { [K in SettingKey]: SettingValue<K> };
  /** The stored strings, for a form that edits them. */
  raw: Record<SettingKey, string>;
  /** Which layer each value came from — 'default' / 'global' read as inherited. */
  sources: Record<SettingKey, SettingSource>;
};

/** Every setting for `scope`, with the layer each one came from. */
export async function resolveSettings(scope?: SettingsScope): Promise<ResolvedSettings> {
  const resolved = scopeOf(scope);
  const rows = await loadRows(resolved);
  const values = {} as Record<SettingKey, unknown>;
  const raw = {} as Record<SettingKey, string>;
  const sources = {} as Record<SettingKey, SettingSource>;
  for (const key of Object.keys(SETTING_DEFAULTS) as SettingKey[]) {
    const picked = pickSetting(rows, key, resolved);
    values[key] = parseSettingValue(key, picked.raw);
    raw[key] = picked.raw;
    sources[key] = picked.source;
  }
  return { values: values as ResolvedSettings['values'], raw, sources };
}

/**
 * The settings scope of a relation or a programme (Cohort), in one query.
 * `null` when the row does not exist. The org is the row's own, or the default
 * org for a legacy org-less row (the `settingsOrgOfRow` rule) — never `null`,
 * which would address the global layer.
 */
export async function resolveProgramScope(
  ref: { relationId: string } | { cohortId: string },
): Promise<{ orgId: string; programId: string | null } | null> {
  const row =
    'relationId' in ref
      ? await prisma.mentorshipRelation
          .findUnique({ where: { id: ref.relationId }, select: { orgId: true, cohortId: true } })
          .then((r) => r && { orgId: r.orgId, programId: r.cohortId })
      : await prisma.cohort
          .findUnique({ where: { id: ref.cohortId }, select: { orgId: true, id: true } })
          .then((c) => c && { orgId: c.orgId, programId: c.id });
  if (!row) return null;
  return { orgId: await settingsOrgOfRow(row.orgId), programId: row.programId };
}
