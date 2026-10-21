// Operator CLI: map a public hostname to the tenant its sessionless forms write
// into (#2569) — `Organization.publicHost`.
//
//   node prisma/set-public-host.mjs --org <slug|id> --host marketing.example.com
//   node prisma/set-public-host.mjs --org <slug|id> --clear
//   node prisma/set-public-host.mjs --list
//
// Until a MARKETING host is mapped, the demo form on its landing is CLOSED
// ("not available right now") — by design: an unmapped marketing host never
// falls back to the internship tenant (src/lib/publicHostRule.ts). Run it once
// per environment, with that environment's own marketing host (one of its
// MARKETING_HOSTS), after the MARKETING org exists; it is idempotent.
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

/**
 * One mapped org's brand completeness (#2922), from plain facts so the unit test
 * runs it without a database. A mapped host serves its org's brand once the org
 * carries any brand field (src/lib/brandRule.ts hasAnyBrand); until then the
 * host shows the product default. Says only set / not set and the mark's
 * version — never the values.
 */
export function brandReport(org) {
  const set = (v) => typeof v === 'string' && v.trim() !== '';
  const fields = [org.brandName, org.brandColor, org.brandTileColor, org.brandAccent, org.brandPalette, org.brandMarkVersion];
  const summary =
    `brand: name=${set(org.brandName) ? 'set' : '—'} mark=${set(org.brandMarkVersion) ? org.brandMarkVersion : '—'} ` +
    `colour=${set(org.brandColor) ? 'set' : '—'} tile=${set(org.brandTileColor) ? 'set' : '—'} ` +
    `accent=${set(org.brandAccent) ? org.brandAccent : '—'} palette=${set(org.brandPalette) ? 'set' : '—'}`;
  const warning = fields.some(set)
    ? null
    : `WARNING: ${org.slug} (${org.id}) is mapped to ${org.publicHost} but carries no brand data — ` +
      'that host shows the product default name, colour and icons. Set them in Admin → Organizations → White-label branding.';
  return { summary, warning };
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
        select: {
          id: true, slug: true, vertical: true, publicHost: true,
          brandName: true, brandColor: true, brandTileColor: true, brandAccent: true, brandPalette: true, brandMarkVersion: true,
        },
      });
      if (rows.length === 0) console.log('No public hosts are mapped.');
      for (const r of rows) {
        console.log(`${r.publicHost}\t→ ${r.slug} (${r.id}, ${r.vertical})`);
        // What that host will wear (#2922): report only, never the values.
        const { summary, warning } = brandReport(r);
        console.log(`\t  ${summary}`);
        if (warning) console.log(warning);
      }
      // The rollout gap made visible (#2569 review): a MARKETING org that claims
      // no host means its landing's demo form is closed. Printed with the exact
      // command, so the deploy log (infra/deploy-prod.sh runs --list, report
      // only) tells the operator what to run instead of leaving it to memory.
      const unmapped = await prisma.organization.findMany({
        where: { vertical: 'MARKETING', publicHost: null },
        select: { id: true, slug: true },
      });
      for (const o of unmapped) {
        console.log(
          `WARNING: MARKETING org ${o.slug} (${o.id}) claims no public host — its demo form is closed. ` +
            `Map it: node prisma/set-public-host.mjs --org ${o.slug} --host <marketing host>`,
        );
      }
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
      await prisma.organization.update({ where: { id: org.id }, data: { publicHost: null, publicHostToken: null, publicHostVerifiedAt: null } });
      console.log(`Cleared the public host of ${org.slug} (was ${org.publicHost ?? 'none'}).`);
      return;
    }

    const host = normalizeHost(arg('host'));
    if (!host) throw new Error('--host must be a bare hostname, e.g. marketing.example.com');
    const holder = await prisma.organization.findUnique({ where: { publicHost: host }, select: { id: true, slug: true } });
    if (holder && holder.id !== org.id) {
      throw new Error(`${host} already belongs to ${holder.slug} (${holder.id}); clear it there first`);
    }
    // A proof of ownership belongs to the host it was made for (#1661): a new
    // host starts unverified, the same host keeps its stamp.
    const moved = org.publicHost !== host;
    await prisma.organization.update({
      where: { id: org.id },
      data: { publicHost: host, ...(moved ? { publicHostToken: null, publicHostVerifiedAt: null } : {}) },
    });
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
