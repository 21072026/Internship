// Idempotent backfill for multi-tenancy Phase 1 (#543): ensure a single default
// Organization exists and every tenant-scoped row points at it. Additive and
// safe — nothing enforces isolation yet, so this only fills the nullable orgId
// columns. Runs on deploy (deploy-prod.sh / deploy.yml) and in db seed.
//
// Completeness matters more than it looks (#1557): once MT_ENFORCE_ISOLATION is
// on, the Prisma middleware injects `where: { orgId }` into every query on a
// tenant model, so a row left at orgId = NULL matches nobody and disappears
// from the product. A complete backfill is step 1 of the rollout checklist in
// docs/tenant-isolation.md — this script must cover EVERY nullable orgId
// column, which is why the model list is derived from the schema (via the
// generated DMMF) instead of being hand-maintained here: a hardcoded list drifts
// the moment somebody adds orgId to a new model, and it did (6 of 19 covered).
import { Prisma, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const DEFAULT_SLUG = process.env.DEFAULT_ORG_SLUG || 'default';
const DEFAULT_NAME = process.env.DEFAULT_ORG_NAME || 'Default Organization';

// Models that carry an orgId but must NOT be backfilled. Keep the reason with
// the entry — an unexplained exclusion reads as an oversight and gets "fixed".
const EXCLUDED = new Map([
  // Setting: legacy rows deliberately stay orgId = NULL. NULL is the *global
  // fallback layer* — a setting with no org applies to every tenant, and a
  // per-org row overrides it. Assigning the existing rows to the default org
  // would turn platform-wide defaults into one tenant's private settings and
  // leave every other tenant with no configuration at all. Do not "fix" this.
  ['Setting', 'global fallback layer — NULL rows apply to every tenant'],
]);

/** Prisma client property for a model name (Prisma lower-cases the first char). */
const clientKey = (modelName) => modelName.charAt(0).toLowerCase() + modelName.slice(1);

/**
 * Every model carrying a scalar `orgId`, read straight from the schema so the
 * list can never drift from prisma/schema.prisma. `isRequired === false` means
 * the column is nullable, i.e. it can actually hold rows needing a backfill.
 */
function orgIdModels() {
  return Prisma.dmmf.datamodel.models
    .map((model) => {
      const field = model.fields.find((f) => f.name === 'orgId' && f.kind === 'scalar');
      if (!field) return null;
      return { name: model.name, key: clientKey(model.name), nullable: !field.isRequired };
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function main() {
  // The legacy single-tenant org is grandfathered to ENTERPRISE (unlimited)
  // so per-tenant plan limits (#547) never constrain existing production data.
  // New tenants created via the admin screen start on FREE (schema default).
  const org = await prisma.organization.upsert({
    where: { slug: DEFAULT_SLUG },
    update: { plan: 'ENTERPRISE' },
    create: { slug: DEFAULT_SLUG, name: DEFAULT_NAME, plan: 'ENTERPRISE' },
    select: { id: true },
  });

  const all = orgIdModels();
  const excluded = all.filter((m) => EXCLUDED.has(m.name));
  const remaining = all.filter((m) => !EXCLUDED.has(m.name));
  // A non-nullable orgId column cannot hold NULLs, so there is nothing to fill.
  const skipped = remaining.filter((m) => !m.nullable);
  const targets = remaining.filter((m) => m.nullable);

  const log = (line) => console.log(`backfill-organization: ${line}`);

  log(`${all.length} model(s) carry orgId in the schema`);
  for (const m of excluded) log(`  skip ${m.name} — excluded: ${EXCLUDED.get(m.name)}`);
  if (skipped.length) {
    log(`  skip ${skipped.map((m) => m.name).join(', ')} — orgId is NOT NULL, cannot hold NULLs`);
  }

  const missing = targets.filter((m) => typeof prisma[m.key]?.updateMany !== 'function');
  if (missing.length) {
    // Derivation broke (stale generated client, renamed model). Fail loudly
    // rather than silently backfilling a subset — the whole point of #1557.
    throw new Error(
      `no Prisma client delegate for: ${missing.map((m) => `${m.name} (prisma.${m.key})`).join(', ')}` +
        ' — run `npx prisma generate` so the client matches the schema',
    );
  }

  let total = 0;
  for (const m of targets) {
    const res = await prisma[m.key].updateMany({ where: { orgId: null }, data: { orgId: org.id } });
    total += res.count;
    log(`  ${m.name.padEnd(22)} +${res.count}`);
  }

  // Verify, don't assume: re-count after the pass so a column we failed to fill
  // (a row written between the update and now, a model the update silently
  // no-opped on) cannot pass as a clean backfill.
  const leftovers = [];
  for (const m of targets) {
    const count = await prisma[m.key].count({ where: { orgId: null } });
    if (count) leftovers.push(`${m.name} (${count})`);
  }

  log(
    `default org ${DEFAULT_SLUG}; ${targets.length} model(s) backfilled, ${total} row(s) assigned.`,
  );

  if (leftovers.length) {
    throw new Error(`orgId still NULL after the pass: ${leftovers.join(', ')}`);
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
