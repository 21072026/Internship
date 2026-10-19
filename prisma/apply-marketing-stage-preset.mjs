// Operator CLI: bring an EXISTING MARKETING tenant's stage set up to the
// current MARKETING_FUNNEL preset (#2959, docs/marketing-vertical/stage-preset.md).
//
//   node prisma/apply-marketing-stage-preset.mjs --org <slug|id>            # dry run: prints the diff
//   node prisma/apply-marketing-stage-preset.mjs --org <slug|id> --apply    # writes it
//   … --json                                                               # the plan as JSON (tests)
//
// WHY THIS EXISTS
//   A MARKETING org gets the preset once, at creation (provisionStagePreset in
//   src/lib/pipelineStages.ts). Editing the preset afterwards never reaches an
//   org that already applied it (the header of src/lib/programTemplates.ts), so
//   a tenant provisioned before #2840 still carries DEAL_PROPOSAL /
//   DEAL_NEGOTIATION and no TRIAL_* stages. This brings one org forward.
//
// WHAT IT DOES — and how it differs from replaceStages()
//   replaceStages() is the one writer the admin editor uses: deleteMany +
//   createMany of the whole set. It cannot be called from here (it is
//   TypeScript under src/, and the runtime image is node:20-slim with no src/),
//   and its delete-everything shape is also the wrong tool for an org that is
//   live: it would strand a record on a key that disappears. So this is a
//   minimal plain-ESM mirror that writes the SAME rows (same normalisation:
//   label trimmed, blank colour = null) but row by row:
//     • every preset stage is upserted on (orgId, key): label, order, flags and
//       colour exactly as the preset stores them (the English labels; the
//       viewer's locale is resolved on read, #2268);
//     • a key the preset does not have is deleted ONLY when no relation sits
//       on it (any status) and no StageSla row names it. Otherwise the whole
//       run is REFUSED, nothing is written, and the output says which key and
//       why — the same two refusals as templateApplyBlockers()
//       ('stranded_relations', 'stale_slas');
//     • the preset's service levels are written the way PUT /api/admin/stage-sla
//       writes templateSlaPayload(): every preset stage gets the preset's days
//       or none, an existing wipLimit is kept, and a row left with neither is
//       deleted.
//   All of it in ONE transaction. Refuses an org whose vertical is not
//   MARKETING (exit 1). Idempotent: a second run reports nothing to do.
//
// THE MIRRORS
//   The stages come from MARKETING_DEMO_STAGES (prisma/seed-demo-marketing.mjs),
//   already compared field for field against templateStagePayload() by
//   scripts/test/marketing-demo-tenant.test.mjs. MARKETING_PRESET_SLAS below is
//   compared against templateSlaPayload() and the refusals against
//   templateApplyBlockers() by scripts/test/marketing-ops-clis.test.mjs —
//   change the preset and the mirrors in one commit.
import { PrismaClient, Prisma } from '@prisma/client';
import { MARKETING_DEMO_STAGES } from './seed-demo-marketing.mjs';

/** The preset's stages, as provisionStagePreset() hands them to replaceStages(). */
export const MARKETING_PRESET_STAGES = MARKETING_DEMO_STAGES;

/**
 * MIRROR of `templateSlaPayload(defaultTemplateForVertical('MARKETING')).slas`:
 * one entry per preset stage, `days: null` where the preset sets no service level.
 */
export const MARKETING_PRESET_SLAS = [
  { stageKey: 'LEAD_NEW', days: 1 },
  { stageKey: 'LEAD_CONTACTED', days: 3 },
  { stageKey: 'LEAD_QUALIFIED', days: 7 },
  { stageKey: 'TRIAL_ACTIVE', days: null },
  { stageKey: 'TRIAL_EXPIRED', days: 7 },
  { stageKey: 'DEAL_WON', days: null },
  { stageKey: 'DEAL_LOST', days: null },
];

const STAGE_FIELDS = ['label', 'order', 'isTerminal', 'isOffPath', 'color'];

/** replaceStages()'s normalisation of one written row (marketing keys are never canonical keys). */
export function normalizeStageRow(s) {
  return {
    key: s.key,
    label: (s.label ?? '').trim(),
    order: s.order,
    isTerminal: s.isTerminal ?? false,
    isOffPath: s.isOffPath ?? false,
    color: s.color && s.color.trim() ? s.color.trim() : null,
  };
}

/**
 * The whole plan, pure. Inputs are what the database holds for ONE org:
 *   current      — its PipelineStage rows
 *   occupied     — { [stageKey]: number of relations on it } (any status)
 *   slaRows      — its StageSla rows { stageKey, days, wipLimit }
 * Returns { stages, removals, blockers, slas, changes } where `changes` is the
 * number of writes an --apply would make (0 = nothing to do).
 */
export function planStagePreset({
  presetStages = MARKETING_PRESET_STAGES,
  presetSlas = MARKETING_PRESET_SLAS,
  current,
  occupied,
  slaRows,
}) {
  const want = presetStages.map(normalizeStageRow);
  const wantKeys = new Set(want.map((s) => s.key));
  const have = new Map(current.map((s) => [s.key, normalizeStageRow(s)]));

  const stages = want.map((after) => {
    const before = have.get(after.key) ?? null;
    if (!before) return { key: after.key, action: 'create', before: null, after, changed: STAGE_FIELDS };
    const changed = STAGE_FIELDS.filter((f) => before[f] !== after[f]);
    return { key: after.key, action: changed.length ? 'update' : 'unchanged', before, after, changed };
  });

  // Keys outside the preset: a stage row, a relation or a service level.
  const blockers = [];
  for (const [key, count] of Object.entries(occupied)) {
    if (count > 0 && !wantKeys.has(key)) blockers.push({ key, reason: 'stranded_relations', count });
  }
  for (const row of slaRows) {
    if (!wantKeys.has(row.stageKey)) blockers.push({ key: row.stageKey, reason: 'stale_slas', days: row.days ?? null, wipLimit: row.wipLimit ?? null });
  }
  blockers.sort((a, b) => a.key.localeCompare(b.key) || a.reason.localeCompare(b.reason));
  const blocked = new Set(blockers.map((b) => b.key));
  const removals = current
    .filter((s) => !wantKeys.has(s.key))
    .map((s) => ({ key: s.key, before: normalizeStageRow(s), blocked: blocked.has(s.key) }));

  // Service levels, exactly as PUT /api/admin/stage-sla stores templateSlaPayload().
  const slaByKey = new Map(slaRows.map((r) => [r.stageKey, r]));
  const slas = presetSlas.map(({ stageKey, days: rawDays }) => {
    const days = rawDays != null && rawDays > 0 ? rawDays : null;
    const row = slaByKey.get(stageKey) ?? null;
    const wipLimit = row?.wipLimit ?? null;
    const before = row ? { days: row.days ?? null, wipLimit } : null;
    if (days == null && wipLimit == null) {
      return { stageKey, action: row ? 'delete' : 'unchanged', before, after: null };
    }
    const after = { days, wipLimit };
    if (!row) return { stageKey, action: 'create', before, after };
    return { stageKey, action: before.days === days ? 'unchanged' : 'update', before, after };
  });

  const changes =
    stages.filter((s) => s.action !== 'unchanged').length +
    removals.length +
    slas.filter((s) => s.action !== 'unchanged').length;
  return { stages, removals, blockers, slas, changes };
}

const fmtStage = (s) =>
  `"${s.label}" order ${s.order}${s.isTerminal ? ' terminal' : ''}${s.isOffPath ? ' off-path' : ''} ${s.color ?? 'no colour'}`;
const fmtSla = (v) => (v ? `${v.days == null ? 'no SLA' : `${v.days}d`}${v.wipLimit != null ? `, WIP ${v.wipLimit}` : ''}` : '—');

/** The human-readable diff, one line per stage / service level. */
export function describePlan(plan) {
  const lines = ['Stages (before → after):'];
  for (const s of plan.stages) {
    if (s.action === 'create') lines.push(`  + ${s.key.padEnd(16)} ${fmtStage(s.after)}`);
    else if (s.action === 'unchanged') lines.push(`  = ${s.key.padEnd(16)} ${fmtStage(s.after)}`);
    else {
      const diff = s.changed.map((f) => `${f} ${JSON.stringify(s.before[f])} → ${JSON.stringify(s.after[f])}`).join(', ');
      lines.push(`  ~ ${s.key.padEnd(16)} ${diff}`);
    }
  }
  for (const r of plan.removals) {
    lines.push(`  ${r.blocked ? '!' : '-'} ${r.key.padEnd(16)} ${fmtStage(r.before)}${r.blocked ? '  (IN USE — see below)' : '  (not in the preset, unused: deleted)'}`);
  }
  lines.push('Service levels (before → after):');
  for (const s of plan.slas) {
    const mark = { create: '+', update: '~', delete: '-', unchanged: '=' }[s.action];
    lines.push(`  ${mark} ${s.stageKey.padEnd(16)} ${fmtSla(s.before)} → ${fmtSla(s.after)}`);
  }
  if (plan.blockers.length) {
    lines.push('REFUSED — keys outside the preset that are still in use:');
    for (const b of plan.blockers) {
      lines.push(
        b.reason === 'stranded_relations'
          ? `  ${b.key}: ${b.count} funnel record(s) sit on it. Move them to a preset stage first (the board, or a stage change on each record).`
          : `  ${b.key}: a StageSla row names it (${fmtSla(b)}). Clear that service level on /admin/settings (stage SLAs) while the stage still exists.`,
      );
    }
  }
  return lines.join('\n');
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name) => process.argv.includes(`--${name}`);

const USAGE = 'Usage: node prisma/apply-marketing-stage-preset.mjs --org <slug|id> [--apply] [--json]';

async function loadState(db, orgId) {
  const [current, grouped, slaRows] = await Promise.all([
    db.pipelineStage.findMany({ where: { orgId }, orderBy: { order: 'asc' } }),
    db.mentorshipRelation.groupBy({ by: ['pipelineStatus'], where: { orgId }, _count: { _all: true } }),
    db.stageSla.findMany({ where: { orgId }, select: { stageKey: true, days: true, wipLimit: true } }),
  ]);
  const occupied = Object.fromEntries(grouped.map((g) => [g.pipelineStatus, g._count._all]));
  return { current, occupied, slaRows };
}

async function main() {
  const orgRef = (arg('org') ?? '').trim();
  if (!orgRef) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  const apply = has('apply');
  const json = has('json');
  const prisma = new PrismaClient();
  try {
    const org = await prisma.organization.findFirst({
      where: { OR: [{ id: orgRef }, { slug: orgRef }] },
      select: { id: true, slug: true, vertical: true },
    });
    if (!org) {
      console.error(`No organization with slug or id "${orgRef}".`);
      process.exitCode = 1;
      return;
    }
    if (org.vertical !== 'MARKETING') {
      console.error(`REFUSED: ${org.slug} is not a MARKETING tenant (vertical ${org.vertical ?? 'INTERNSHIP'}); the marketing preset is not its stage set.`);
      process.exitCode = 1;
      return;
    }

    // Read and write inside one transaction. A plain read there takes no lock
    // (InnoDB, REPEATABLE READ), so before a retired key is deleted its
    // records are read again WITH a lock: `FOR UPDATE` on the pipelineStatus
    // index holds every row on those keys and the gap a concurrent move would
    // land in until the commit. A record found there refuses the run, and the
    // transaction rolls everything back.
    const outcome = await prisma.$transaction(async (tx) => {
      const plan = planStagePreset(await loadState(tx, org.id));
      if (!apply || plan.blockers.length || plan.changes === 0) return { plan, written: false };
      if (plan.removals.length) {
        const keys = plan.removals.map((r) => r.key);
        const onRetired = await tx.$queryRaw`SELECT \`id\` FROM \`MentorshipRelation\` WHERE \`orgId\` = ${org.id} AND \`pipelineStatus\` IN (${Prisma.join(keys)}) FOR UPDATE`;
        if (onRetired.length) {
          throw new Error(`REFUSED: ${onRetired.length} funnel record(s) moved onto ${keys.join(', ')} while the run was planned; nothing was written. Run it again.`);
        }
      }
      for (const s of plan.stages) {
        if (s.action === 'unchanged') continue;
        const { key, ...data } = s.after;
        await tx.pipelineStage.upsert({
          where: { orgId_key: { orgId: org.id, key } },
          create: { orgId: org.id, key, ...data },
          update: data,
        });
      }
      if (plan.removals.length) {
        await tx.pipelineStage.deleteMany({ where: { orgId: org.id, key: { in: plan.removals.map((r) => r.key) } } });
      }
      for (const s of plan.slas) {
        if (s.action === 'delete') await tx.stageSla.deleteMany({ where: { orgId: org.id, stageKey: s.stageKey } });
        if (s.action === 'create' || s.action === 'update') {
          await tx.stageSla.upsert({
            where: { orgId_stageKey: { orgId: org.id, stageKey: s.stageKey } },
            create: { orgId: org.id, stageKey: s.stageKey, days: s.after.days, wipLimit: s.after.wipLimit },
            update: { days: s.after.days, wipLimit: s.after.wipLimit },
          });
        }
      }
      return { plan, written: true };
    }, { timeout: 60_000 });

    const { plan, written } = outcome;
    if (json) {
      console.log(JSON.stringify({ org: org.slug, apply, written, ...plan }));
    } else {
      console.log(`${org.slug} (${org.id}) — MARKETING stage preset, ${apply ? 'APPLY' : 'dry run'}`);
      console.log(describePlan(plan));
      if (plan.blockers.length) console.log('Nothing was written.');
      else if (plan.changes === 0) console.log('Already on the current preset — nothing to do.');
      else if (written) console.log(`Written: ${plan.changes} change(s).`);
      else console.log(`Dry run: ${plan.changes} change(s) would be written. Re-run with --apply.`);
    }
    if (plan.blockers.length) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

// Import-safe: only runs as a CLI, so a test can import the pure plan.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
