// Operator CLI: map a public hostname to the tenant its sessionless forms write
// into (#2569) — `Organization.publicHost`.
//
//   node prisma/set-public-host.mjs --org <slug|id> --host marketing.bcsit-gmbh.de
//   node prisma/set-public-host.mjs --org <slug|id> --clear
//   node prisma/set-public-host.mjs --list
//
// Until a MARKETING host is mapped, the demo form on its landing is CLOSED
// ("not available right now") — by design: an unmapped marketing host never
// falls back to the internship tenant (src/lib/publicHostRule.ts). Run it once
// per environment (prod: marketing.bcsit-gmbh.de, preview: marketing.bcsit-gmbh.dev)
// after the MARKETING org exists; it is idempotent.
//
// Refusals, so a mistyped mapping fails loudly instead of matching nothing:
//   • the host must be a bare hostname (no scheme, port, path or wildcard) —
//     `normalizeHost` below is the plain-ESM mirror of `normalizePublicHost` in
//     src/lib/publicHostRule.ts (scripts cannot import a TS module on the
//     server's Node 20), and scripts/test/public-host-org.test.mjs runs both on
//     one corpus so they cannot drift;
//   • the host must not already belong to ANOTHER org (the column is unique; the
//     script says which org holds it rather than surfacing a P2002).
// It does not check MARKETING_HOSTS: whether the host serves the marketing
// landing is deployment config, and the form stays closed on a vertical
// mismatch anyway.
import { PrismaClient } from '@prisma/client';

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOST_RE = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`);

export function normalizeHost(value) {
  if (typeof value !== 'string') return null;
  const host = value.trim().toLowerCase();
  if (!host || host.length > 253) return null;
  return HOST_RE.test(host) ? host : null;
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const prisma = new PrismaClient();
  try {
    if (process.argv.includes('--list')) {
      const rows = await prisma.organization.findMany({
        where: { publicHost: { not: null } },
        select: { id: true, slug: true, vertical: true, publicHost: true },
      });
      if (rows.length === 0) console.log('No public hosts are mapped.');
      for (const r of rows) console.log(`${r.publicHost}\t→ ${r.slug} (${r.id}, ${r.vertical})`);
      return;
    }

    const orgRef = arg('org');
    if (!orgRef) throw new Error('--org <slug|id> is required');
    const org = await prisma.organization.findFirst({
      where: { OR: [{ id: orgRef }, { slug: orgRef }] },
      select: { id: true, slug: true, vertical: true, publicHost: true },
    });
    if (!org) throw new Error(`No organization with id or slug "${orgRef}"`);

    if (process.argv.includes('--clear')) {
      await prisma.organization.update({ where: { id: org.id }, data: { publicHost: null } });
      console.log(`Cleared the public host of ${org.slug} (was ${org.publicHost ?? 'none'}).`);
      return;
    }

    const host = normalizeHost(arg('host'));
    if (!host) throw new Error('--host must be a bare hostname, e.g. marketing.bcsit-gmbh.de');
    const holder = await prisma.organization.findUnique({ where: { publicHost: host }, select: { id: true, slug: true } });
    if (holder && holder.id !== org.id) {
      throw new Error(`${host} already belongs to ${holder.slug} (${holder.id}); clear it there first`);
    }
    await prisma.organization.update({ where: { id: org.id }, data: { publicHost: host } });
    console.log(`${host} → ${org.slug} (${org.id}, ${org.vertical}).`);
  } finally {
    await prisma.$disconnect();
  }
}

// Run only as a CLI, so the unit test can import normalizeHost.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`set-public-host: ${e.message}`);
    process.exit(1);
  });
}
