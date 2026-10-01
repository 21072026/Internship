// Operator CLI: make an address the SUPER ADMIN OF ONE WORLD (docs/worlds.md
// § Super admin).
//
//   node prisma/set-super-admin.mjs --email ops@example.com --world MARKETING            # dry run
//   node prisma/set-super-admin.mjs --email ops@example.com --world MARKETING --confirm  # write
//   node prisma/set-super-admin.mjs --email ops@example.com --world INTERNSHIP --revoke --confirm
//   node prisma/set-super-admin.mjs --list
//
// Super admin is per world: the INTERNSHIP and the MARKETING super admin are
// different accounts, and each manages only its own product's organizations.
// One person may be both — as their two accounts, one per world, which is what
// this script writes: it touches ONLY the address's account IN THE NAMED WORLD
// and never the same address's account in the other one.
//
// Idempotent (a second run reports "unchanged"), a DRY RUN unless --confirm, and
// refuses loudly rather than guessing:
//   • no account for the address in that world → exit 1 (invite them first);
//   • more than one account for it in that world (two orgs of one product hold
//     the address — the app never creates that, a vertical move could) → exit 1;
//   • the account is not an active ADMIN → exit 1 (the flag never grants a
//     lesser role the admin surface: src/lib/superAdmin.ts).
//
// The world rule is the plain-ESM mirror of `worldUserWhere`
// (src/lib/userWorld.ts): a non-default world is exactly its vertical's
// organizations; the default world (INTERNSHIP) is everything that is not one
// of the others, including a user with no organization. Scripts cannot import
// a TS module on the server's Node 20, hence the copy — keep them together.
import { PrismaClient } from '@prisma/client';

const WORLDS = ['INTERNSHIP', 'MARKETING'];
const DEFAULT_WORLD = 'INTERNSHIP';

export function worldUserWhere(world) {
  if (world !== DEFAULT_WORLD) return { org: { is: { vertical: world } } };
  const others = WORLDS.filter((w) => w !== DEFAULT_WORLD);
  return { NOT: { org: { is: { vertical: { in: others } } } } };
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name) => process.argv.includes(`--${name}`);

function worldOf(vertical) {
  return WORLDS.includes(vertical) ? vertical : DEFAULT_WORLD;
}

async function main() {
  const prisma = new PrismaClient();
  try {
    if (has('list')) {
      const rows = await prisma.user.findMany({
        where: { isSuperAdmin: true },
        select: { email: true, isActive: true, role: true, org: { select: { slug: true, vertical: true } } },
        orderBy: { email: 'asc' },
      });
      if (!rows.length) console.log('No super admins.');
      for (const r of rows) {
        console.log(
          `${worldOf(r.org?.vertical)}\t${r.email}\t(${r.org?.slug ?? 'no org'}, ${r.role}${r.isActive ? '' : ', INACTIVE'})`,
        );
      }
      return;
    }

    const email = (arg('email') ?? '').trim().toLowerCase();
    const world = (arg('world') ?? '').trim().toUpperCase();
    const revoke = has('revoke');
    const confirm = has('confirm');
    if (!email || !WORLDS.includes(world)) {
      console.error('Usage: node prisma/set-super-admin.mjs --email <address> --world INTERNSHIP|MARKETING [--revoke] [--confirm] | --list');
      process.exitCode = 2;
      return;
    }

    const rows = await prisma.user.findMany({
      where: { email, ...worldUserWhere(world) },
      select: { id: true, role: true, isActive: true, isSuperAdmin: true, org: { select: { slug: true } } },
    });
    if (rows.length === 0) {
      console.error(`No account for ${email} in the ${world} world. Invite them into one of its organizations first.`);
      process.exitCode = 1;
      return;
    }
    if (rows.length > 1) {
      console.error(`${rows.length} accounts for ${email} in the ${world} world (${rows.map((r) => r.org?.slug ?? 'no org').join(', ')}); refusing to guess.`);
      process.exitCode = 1;
      return;
    }
    const [user] = rows;
    const want = !revoke;
    if (want && (user.role !== 'ADMIN' || !user.isActive)) {
      console.error(`${email} in ${world} is ${user.isActive ? '' : 'inactive '}${user.role}; only an active ADMIN can be a super admin.`);
      process.exitCode = 1;
      return;
    }
    if (user.isSuperAdmin === want) {
      console.log(`unchanged: ${email} in ${world} (${user.org?.slug ?? 'no org'}) is ${want ? 'already' : 'not'} a super admin.`);
      return;
    }
    if (!confirm) {
      console.log(`DRY RUN: would ${want ? 'grant' : 'revoke'} super admin for ${email} in ${world} (${user.org?.slug ?? 'no org'}). Re-run with --confirm to write.`);
      return;
    }
    await prisma.user.update({ where: { id: user.id }, data: { isSuperAdmin: want } });
    console.log(`${want ? 'granted' : 'revoked'}: super admin for ${email} in ${world} (${user.org?.slug ?? 'no org'}).`);
  } finally {
    await prisma.$disconnect();
  }
}

// Import-safe: only runs as a CLI, so a test can import worldUserWhere.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
