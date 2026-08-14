import { PrismaClient } from '@prisma/client';

// Wipe the PUBLIC DEMO database (#966), so the scheduled reset can re-seed it
// from scratch. Run by .github/workflows/demo-reset.yml, never by the app:
// there is deliberately no HTTP endpoint for this, so there is no reset secret
// to leak and no route that can be pointed at the wrong database.
//
// Usage:  DEMO_MODE=true node prisma/reset-demo.mjs
//         (then: node prisma/seed.mjs && node prisma/seed-demo.mjs)
//
// SAFETY — this script drops every row in the database it is pointed at, so it
// refuses unless BOTH hold:
//   1. DEMO_MODE=true, and
//   2. the database NAME ends in `_demo` (e.g. internship_crm_demo).
//
// (2) is the guard that matters. An env flag can be copied into the wrong
// env file by accident; a database name cannot be, because production's is
// `internship_crm` and preview's is `internship_crm_preview`. Neither can ever
// satisfy the check, whatever DEMO_MODE happens to say.

function databaseName(url) {
  // mysql://user:pass@host:port/NAME?params — take NAME, drop any query string.
  // Parsed by hand rather than with `new URL()` because passwords in these URLs
  // routinely contain characters that make the WHATWG parser throw.
  const afterHost = url.slice(url.indexOf('@') + 1);
  const slash = afterHost.indexOf('/');
  if (slash === -1) return '';
  return afterHost.slice(slash + 1).split('?')[0];
}

function assertDemoTarget() {
  if (process.env.DEMO_MODE !== 'true') {
    console.error('reset-demo: refusing to run — DEMO_MODE is not "true".');
    process.exit(1);
  }
  const url = process.env.DATABASE_URL || '';
  if (!url) {
    console.error('reset-demo: refusing to run — DATABASE_URL is not set.');
    process.exit(1);
  }
  const name = databaseName(url);
  if (!/_demo$/.test(name)) {
    console.error(
      `reset-demo: refusing to run — database "${name || '(unparsed)'}" does not end in "_demo".\n` +
      'This script only ever wipes the dedicated demo database. There is no override flag ' +
      'on purpose: if you need to wipe something else, do it deliberately by hand.'
    );
    process.exit(1);
  }
  return name;
}

const name = assertDemoTarget();
const prisma = new PrismaClient();

try {
  const rows = await prisma.$queryRaw`
    SELECT table_name AS t
    FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'
  `;
  // Enumerate + TRUNCATE with FK checks off, rather than deleting model by
  // model in dependency order: the model list drifts every time the schema
  // grows a table (this repo added five in one day), and a wipe that silently
  // misses a new table leaves the demo carrying the previous visitor's data.
  const tables = rows.map((r) => r.t ?? r.TABLE_NAME).filter((t) => t && t !== '_prisma_migrations');
  if (tables.length === 0) {
    console.log(`reset-demo: ${name} has no tables yet — nothing to wipe.`);
  } else {
    await prisma.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 0');
    try {
      for (const t of tables) {
        await prisma.$executeRawUnsafe(`TRUNCATE TABLE \`${t}\``);
      }
    } finally {
      // Restore even if one TRUNCATE fails: leaving FK checks off would let the
      // app write referentially broken rows for as long as this connection lives.
      await prisma.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 1');
    }
    console.log(`reset-demo: wiped ${tables.length} tables in ${name}.`);
  }
} finally {
  await prisma.$disconnect();
}
