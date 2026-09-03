import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { assertSafeDemoTarget } from '../prisma/demoTarget.mjs';

// Demo-seed FIDELITY check (#2063).
//
// WHY THIS EXISTS
//   scripts/check-demo-blocklist.mjs is the opposite check: it proves the demo
//   refuses the writes it must refuse. This one proves the demo has something
//   to show. The failure it guards against is not a crash — it is a screen that
//   renders perfectly with zero rows behind it. A feature ships, nobody adds it
//   to prisma/seed-demo.mjs, and every demo, every topic environment and every
//   new contributor's local box shows an empty list for it. That is invisible
//   in CI, invisible in review, and only noticed by whoever is mid-demo.
//
//   scripts/demo-fidelity.json declares, per screen, how many rows the seed
//   must produce. This counts them and fails the build on a shortfall, naming
//   the screen AND the issue that owns it.
//
// THE MANIFEST IS A RATCHET, NOT A WISH LIST
//   `minRows` is what the seeder produces TODAY, so the gate is green today and
//   goes red the moment coverage regresses. `target` is what the screen really
//   needs; a row whose minRows is below its target is printed as PENDING with
//   its owning issue on every single run, so unfinished coverage stays loud
//   instead of being quietly deleted from the manifest. Set
//   DEMO_FIDELITY_STRICT=1 to enforce `target` as well — that is how the owning
//   issue verifies its own work before raising minRows.
//
// SAFETY: counting is read-only, but a manifest tuned to synthetic data says
// nothing about a real database, and pointing this at prod would be a PII read.
// It refuses any DATABASE_URL the demo seeder itself would refuse — the SAME
// predicate, imported from prisma/demoTarget.mjs.
//
// Usage: node scripts/check-demo-fidelity.mjs   (npm run check:demo-fidelity)

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST = join(HERE, 'demo-fidelity.json');
const STRICT = process.env.DEMO_FIDELITY_STRICT === '1';

function loadManifest() {
  const raw = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const entries = raw.entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(`${MANIFEST}: "entries" must be a non-empty array`);
  }
  for (const e of entries) {
    for (const field of ['model', 'screen', 'issue']) {
      if (typeof e[field] !== 'string' || e[field].length === 0) {
        throw new Error(`${MANIFEST}: entry ${JSON.stringify(e)} is missing "${field}"`);
      }
    }
    if (!Number.isInteger(e.minRows) || e.minRows < 0) {
      throw new Error(`${MANIFEST}: ${e.model} has a non-integer "minRows"`);
    }
    if (!Number.isInteger(e.target) || e.target < e.minRows) {
      throw new Error(`${MANIFEST}: ${e.model} needs an integer "target" >= minRows`);
    }
  }
  return entries;
}

// Prisma exposes `prisma.mentorshipRelation` for `model MentorshipRelation`.
// Resolve case-insensitively so the manifest can use the schema's own casing,
// and hard-fail on a name that resolves to nothing — a typo in the manifest
// would otherwise count zero models and pass silently, which is exactly the
// class of bug this script exists to prevent.
function delegateFor(prisma, model) {
  const direct = model.charAt(0).toLowerCase() + model.slice(1);
  const candidate = prisma[direct];
  if (candidate && typeof candidate.count === 'function') return candidate;
  const key = Object.keys(prisma).find(
    (k) => !k.startsWith('_') && !k.startsWith('$') && k.toLowerCase() === model.toLowerCase()
  );
  const found = key ? prisma[key] : undefined;
  if (!found || typeof found.count !== 'function') {
    throw new Error(
      `demo-fidelity.json names model "${model}", which is not in the Prisma client. ` +
      'Check the spelling against prisma/schema.prisma — a typo here would be a silent pass.'
    );
  }
  return found;
}

function pad(s, n) {
  return String(s).padEnd(n, ' ');
}

async function main() {
  const entries = loadManifest();

  // --manifest-only validates shape and model names without a database, so the
  // fast CI job catches a malformed or misspelled entry without waiting for the
  // seeded one. It still instantiates the client (lazily — Prisma only connects
  // on the first query) because resolving a model name IS the check.
  if (process.argv.includes('--manifest-only')) {
    const prisma = new PrismaClient();
    for (const e of entries) delegateFor(prisma, e.model);
    await prisma.$disconnect();
    console.log(`demo-fidelity manifest OK — ${entries.length} entries, every model resolves against the Prisma client.`);
    return;
  }

  assertSafeDemoTarget('check-demo-fidelity');

  const prisma = new PrismaClient();
  const rows = [];
  try {
    for (const e of entries) {
      const delegate = delegateFor(prisma, e.model);
      const actual = await delegate.count(e.where ? { where: e.where } : undefined);
      rows.push({ ...e, label: e.label || e.model, actual });
    }
  } finally {
    await prisma.$disconnect();
  }

  const nameWidth = Math.max(5, ...rows.map((r) => r.label.length));
  console.log(`demo-fidelity — counting seeded rows behind ${rows.length} screens` + (STRICT ? ' (STRICT: enforcing target)' : ''));
  console.log('');
  console.log(`  ${pad('model', nameWidth)}  ${pad('expected', 9)}  ${pad('actual', 7)}  status`);
  console.log(`  ${'-'.repeat(nameWidth)}  ${'-'.repeat(9)}  ${'-'.repeat(7)}  ------`);

  const failures = [];
  const pending = [];
  for (const r of rows) {
    const floor = STRICT ? r.target : r.minRows;
    let status;
    if (r.actual < floor) {
      status = 'FAIL';
      failures.push(r);
    } else if (r.minRows < r.target) {
      status = `pending (${r.issue})`;
      pending.push(r);
    } else {
      status = 'ok';
    }
    console.log(`  ${pad(r.label, nameWidth)}  ${pad(`>= ${floor}`, 9)}  ${pad(r.actual, 7)}  ${status}`);
  }
  console.log('');

  if (failures.length > 0) {
    console.error('demo fidelity check FAILED — these screens have no demo data behind them:\n');
    for (const r of failures) {
      const floor = STRICT ? r.target : r.minRows;
      console.error(
        `  - ${r.label}: expected >= ${floor} row(s), found ${r.actual}\n` +
        `      screen: ${r.screen}\n` +
        `      issue:  ${r.issue}\n` +
        '      fix:    add rows for it in prisma/seed-demo.mjs (or, if the drop is deliberate,\n' +
        '              lower minRows in scripts/demo-fidelity.json and say why in the PR).'
      );
    }
    process.exit(1);
  }

  if (pending.length > 0) {
    console.log(`demo fidelity OK (ratchet held) — ${rows.length - pending.length}/${rows.length} screens fully covered.`);
    console.log(`${pending.length} screen(s) still have no seed coverage; the gate holds them at their current count so they cannot`);
    console.log('regress, and lists them here so they are not forgotten:');
    for (const r of pending) {
      console.log(`  - ${r.label}: ${r.actual}/${r.target} — ${r.screen} (${r.issue})`);
    }
  } else {
    console.log(`demo fidelity OK — all ${rows.length} screens have the demo data they need.`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
