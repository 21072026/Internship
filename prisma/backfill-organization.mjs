// Idempotent backfill for multi-tenancy Phase 1 (#543): ensure a single default
// Organization exists and every tenant-scoped row points at it. Additive and
// safe — nothing enforces isolation yet, so this only fills the nullable orgId
// columns. Runs on deploy (deploy-prod.sh / deploy.yml / topic-deploy.sh /
// demo-refresh.sh) and from the seeders, which import assignDefaultOrg().
//
// Completeness matters more than it looks (#1557): once MT_ENFORCE_ISOLATION is
// on, the Prisma middleware injects `where: { orgId }` into every query on a
// tenant model, so a row left at orgId = NULL matches nobody and disappears
// from the product. A complete backfill is step 1 of the rollout checklist in
// docs/tenant-isolation.md — this script must cover EVERY nullable orgId
// column, which is why the model list is derived from the schema (via the
// generated DMMF) instead of being hand-maintained here: a hardcoded list drifts
// the moment somebody adds orgId to a new model, and it did (6 of 23 covered).
import { Prisma, PrismaClient } from '@prisma/client';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const DEFAULT_SLUG = process.env.DEFAULT_ORG_SLUG || 'default';
const DEFAULT_NAME = process.env.DEFAULT_ORG_NAME || 'Default Organization';

// Models that carry an orgId but must NOT be backfilled. Keep the reason with
// the entry — an unexplained exclusion reads as an oversight and gets "fixed".
// Entries are matched by model name and may be pre-emptive: an entry for a
// model that has no orgId column yet simply never matches.
const EXCLUDED = new Map([
  // Setting: pre-emptive — it has NO orgId column today, #1551 adds one. When
  // it does, its legacy rows must stay orgId = NULL: NULL is the *global
  // fallback layer*, a setting with no org applies to every tenant and a
  // per-org row overrides it. Assigning the existing rows to the default org
  // would turn platform-wide defaults into one tenant's private settings and
  // leave every other tenant with no configuration at all. Do not "fix" this;
  // if #1551 lands a different shape, delete the entry deliberately.
  ['Setting', 'global fallback layer — NULL rows apply to every tenant (#1551)'],
]);

// Identifiers come from the DMMF, not from input, but a backticked identifier
// interpolated into SQL is worth one assertion regardless.
const IDENTIFIER = /^[A-Za-z0-9_]+$/;

/**
 * Every model carrying a scalar `orgId`, read straight from the schema so the
 * list can never drift from prisma/schema.prisma. `isRequired === false` means
 * the column is nullable, i.e. it can actually hold rows needing a backfill.
 * The table/column names are the mapped (database) ones, because the pass runs
 * as raw SQL — see assignDefaultOrg().
 */
export function orgIdModels() {
  return Prisma.dmmf.datamodel.models
    .map((model) => {
      const field = model.fields.find((f) => f.name === 'orgId' && f.kind === 'scalar');
      if (!field) return null;
      const table = model.dbName || model.name;
      const column = field.dbName || field.name;
      if (!IDENTIFIER.test(table) || !IDENTIFIER.test(column)) {
        throw new Error(`unsafe identifier in the schema: ${table}.${column}`);
      }
      return { name: model.name, table, column, nullable: !field.isRequired };
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Fill every nullable orgId column with `orgId`.
 *
 * Deliberately raw SQL rather than `updateMany` (#1557 review): Prisma stamps
 * `@updatedAt` on updateMany, and five of the covered models have one
 * (AccountLockout, InterviewPanel, MatchFeedback, MessageTemplate, Offer —
 * plus Company/Project/User). Re-stamping would rewrite the real last-modified
 * time of every legacy row, irreversibly, and `Offer.updatedAt` is returned by
 * /api/offers. A bookkeeping backfill must not look like an edit.
 *
 * The verification is a retry loop, not a single re-count, because a plain
 * "are there NULLs right now?" check is not a signal about the backfill at all:
 * during a prod deploy the old container is still serving (backfills are
 * section 4, the container swap section 5), and three ordinary paths insert
 * orgId = NULL with no tenant context — a failed sign-in against an unknown
 * email (src/lib/accountLockout.ts), the public company-inquiry form and the
 * public mentor-application form. One of those landing between the UPDATE and
 * the COUNT would have failed the check on a perfectly healthy database. A row
 * that survives several consecutive UPDATE+COUNT passes, on the other hand, is
 * one the backfill genuinely cannot fill.
 */
export async function assignDefaultOrg(prisma, orgId, options = {}) {
  const { passes = 3, retryDelayMs = 250, log = (line) => console.log(`backfill-organization: ${line}`) } =
    options;

  const all = orgIdModels();
  const excluded = all.filter((m) => EXCLUDED.has(m.name));
  const remaining = all.filter((m) => !EXCLUDED.has(m.name));
  // A non-nullable orgId column cannot hold NULLs, so there is nothing to fill.
  const skipped = remaining.filter((m) => !m.nullable);
  const targets = remaining.filter((m) => m.nullable);

  log(`${all.length} model(s) carry orgId in the schema`);
  for (const m of excluded) log(`  skip ${m.name} — excluded: ${EXCLUDED.get(m.name)}`);
  if (skipped.length) {
    log(`  skip ${skipped.map((m) => m.name).join(', ')} — orgId is NOT NULL, cannot hold NULLs`);
  }

  const fill = (m) =>
    prisma.$executeRawUnsafe(
      `UPDATE \`${m.table}\` SET \`${m.column}\` = ? WHERE \`${m.column}\` IS NULL`,
      orgId,
    );
  const countNulls = async (m) => {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*) AS n FROM \`${m.table}\` WHERE \`${m.column}\` IS NULL`,
    );
    return Number(rows[0]?.n ?? 0);
  };

  let total = 0;
  let pending = targets;
  let leftovers = [];

  for (let pass = 1; pass <= passes && pending.length; pass++) {
    if (pass > 1) await new Promise((r) => setTimeout(r, retryDelayMs));
    for (const m of pending) {
      const affected = await fill(m);
      total += affected;
      if (affected) log(`  ${m.name.padEnd(22)} +${affected}${pass > 1 ? ` (pass ${pass})` : ''}`);
    }
    leftovers = [];
    for (const m of pending) {
      const count = await countNulls(m);
      if (count) leftovers.push({ model: m, count });
    }
    pending = leftovers.map((l) => l.model);
  }

  log(`${targets.length} model(s) covered, ${total} row(s) assigned.`);

  if (leftovers.length) {
    throw new Error(
      `orgId still NULL after ${passes} passes: ` +
        `${leftovers.map((l) => `${l.model.name} (${l.count})`).join(', ')} — ` +
        'the backfill could not fill these rows',
    );
  }

  return { total, targets: targets.length };
}

/** Create-or-update the default Organization and return its id. */
export async function upsertDefaultOrg(prisma) {
  // The legacy single-tenant org is grandfathered to ENTERPRISE (unlimited)
  // so per-tenant plan limits (#547) never constrain existing production data.
  // New tenants created via the admin screen start on FREE (schema default).
  const org = await prisma.organization.upsert({
    where: { slug: DEFAULT_SLUG },
    update: { plan: 'ENTERPRISE' },
    create: { slug: DEFAULT_SLUG, name: DEFAULT_NAME, plan: 'ENTERPRISE' },
    select: { id: true },
  });
  return org.id;
}

async function main() {
  const prisma = new PrismaClient();
  try {
    const orgId = await upsertDefaultOrg(prisma);
    console.log(`backfill-organization: default org ${DEFAULT_SLUG} (${orgId})`);
    await assignDefaultOrg(prisma, orgId);
  } finally {
    await prisma.$disconnect();
  }
}

// Importable (the seeders reuse assignDefaultOrg) without running the pass.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
