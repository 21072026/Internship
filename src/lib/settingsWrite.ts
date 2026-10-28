// The ONE writer of settings (#1623). Server-only.
//
// `writeSetting()` writes a value into one layer; `revertSetting()` deletes the
// row at one layer so the value is inherited again (a later change at the
// parent then flows down — copying the parent's value would freeze it). Both:
//
//   1. resolve the layer exactly as reads do (`settingOrgId()`), refuse a layer
//      the key's SETTING_SCHEMA scopes do not allow, and check a programme
//      belongs to the org — never trusting an id from a request;
//   2. read the current row and do NOTHING when nothing changes (no no-op rows);
//   3. write the row and one `SettingChange` in the same transaction, the
//      values taken from #1699's `redactedDiff()` under the key's policy
//      (`settingDiffSpec()`), so a `redact` key is stored as "[redacted]";
//   4. after the commit, raise `setting.changed` — the config-audit subscriber
//      turns it into the AuditLog row the tenant's audit drain reads.
//
// Authorization is the CALLER's: a route decides who may write which layer
// (PUT /api/admin/settings; the revert goes through requirePermission). `orgId`
// is a server-side argument — never a value from a request body.
//
// Deliberately a read-modify-write rather than `prisma.setting.upsert`: the
// natural key contains nullable columns, so the compound unique cannot address
// an org row (programId = NULL) or the global row (both NULL), and MySQL treats
// NULLs as distinct — two org rows for one key are possible. This find-then-
// write is what keeps each layer single, and these two functions must stay the
// only writers of Setting rows (npm run check:settings-accessor).

import { prisma } from '@/lib/prisma';
import { emit } from '@/lib/events/emit';
import { redactedDiff, type FieldChange } from '@/lib/events/diff';
import {
  isGlobalSettingKey,
  noteSettingsWritten,
  settingAllowsScope,
  settingDiffSpec,
  settingOrgId,
  unscopedSettings,
  type SettingKey,
  type SettingScope,
} from '@/lib/settings';

export interface SettingActor {
  id: string;
  email?: string | null;
}

export interface SettingWriteOptions {
  /** A programme (Cohort) row inside `orgId` — only for a key with the 'program' scope. */
  programId?: string;
  /** Who made the change. Omitted: a system write (a seed, a job). */
  actor?: SettingActor | null;
}

/** What a write did: the redacted change, or null when nothing changed. */
export type SettingWriteResult = { change: FieldChange; scope: SettingScope; orgId: string | null; programId: string | null } | null;

function layerOf(key: SettingKey, orgId: string | null | undefined, programId: string | null) {
  const org = settingOrgId(orgId);
  if (org !== null && isGlobalSettingKey(key)) {
    throw new Error(`Setting "${key}" is deployment-global and has no per-tenant row (#2628)`);
  }
  if (programId !== null) {
    if (!settingAllowsScope(key, 'program')) throw new Error(`Setting "${key}" has no per-programme row (#1619)`);
    if (org === null) throw new Error('A programme setting needs its org (#1619)');
  }
  const scope: SettingScope = programId !== null ? 'program' : org !== null ? 'org' : 'global';
  return { org, scope };
}

async function apply(
  key: SettingKey,
  next: string | null,
  orgId: string | null | undefined,
  opts: SettingWriteOptions,
): Promise<SettingWriteResult> {
  const programId = opts.programId ?? null;
  const { org, scope } = layerOf(key, orgId, programId);

  const result = await unscopedSettings(() =>
    prisma.$transaction(async (tx) => {
      if (programId !== null) {
        const program = await tx.cohort.findFirst({ where: { id: programId, orgId: org }, select: { id: true } });
        if (!program) throw new Error('Programme not found in this org (#1619)');
      }
      const existing = await tx.setting.findFirst({
        where: { orgId: org, programId, key },
        select: { id: true, value: true },
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      });
      const before = existing ? existing.value : null;
      if (before === next) return null;

      const [change] = redactedDiff({ [key]: before }, { [key]: next }, settingDiffSpec(key));
      if (!change) return null;

      if (next === null) await tx.setting.deleteMany({ where: { orgId: org, programId, key } });
      else if (existing) await tx.setting.update({ where: { id: existing.id }, data: { value: next } });
      else await tx.setting.create({ data: { orgId: org, programId, key, value: next } });

      await tx.settingChange.create({
        data: {
          orgId: org,
          programId,
          key,
          oldValue: change.from === null ? null : String(change.from),
          newValue: change.to === null ? null : String(change.to),
          actorId: opts.actor?.id ?? null,
        },
      });
      return change;
    }),
  );
  noteSettingsWritten();
  if (!result) return null;

  await emit(
    'setting.changed',
    { key, scope, programId, changes: [result] },
    { orgId: org, actor: opts.actor ? { id: opts.actor.id, type: 'user' } : { type: 'system' } },
  );
  return { change: result, scope, orgId: org, programId };
}

/**
 * Write one setting into a single layer. Resolves to the redacted change, or
 * null when the value was already what was asked (nothing written).
 */
export function writeSetting(
  key: SettingKey,
  value: string,
  orgId?: string | null,
  opts: SettingWriteOptions = {},
): Promise<SettingWriteResult> {
  return apply(key, value, orgId, opts);
}

/**
 * Delete the row at one layer so the value is inherited from the next one up.
 * Null when there was no row (already inherited).
 */
export function revertSetting(key: SettingKey, orgId?: string | null, opts: SettingWriteOptions = {}): Promise<SettingWriteResult> {
  return apply(key, null, orgId, opts);
}
