// The production dependency tree, read from package-lock.json (#2059).
//
// Shared by scripts/check-licenses.mjs (the licence inventory) and
// scripts/generate-sbom.mjs (the SBOM), because those two documents claim to
// describe the SAME tree and that claim should be true by construction rather
// than by two parsers happening to agree. It was not: `npm ls --omit=dev`,
// which is what @cyclonedx/cyclonedx-npm walks, pulls in ten dev-only packages
// (`prisma`, `@playwright/test`, `playwright-core`, `@prisma/engines`, …)
// because they are reachable along an OPTIONAL PEER edge from a production
// package — `@prisma/client` declares `peerDependencies: { prisma: "*" }`. The
// lockfile's own `dev` flag does not have that blind spot, so it is the source
// of truth here and the SBOM is pruned back to it.
//
// WHY THE LOCKFILE AND NOT node_modules: it needs no install and no network
// (CI's audit and build-image jobs deliberately skip `npm ci`), and it
// describes what WILL be installed rather than what happens to be on this
// machine. Lockfile v3 (npm 9+) records `license` and `dev` per package, which
// is everything both callers need.
//
// SCOPE NOTE, and it is a real one: `packages` is the tree `npm ci --omit=dev`
// would install. The Docker image installs MORE than that — the Dockerfile runs
// a full `npm ci` because `next build` needs typescript/tailwind, and the runner
// stage copies node_modules wholesale — so devDependencies are physically
// present in the running container even though nothing imports them. That is
// why `devPackages` is returned rather than merely counted: the licence check
// evaluates it too and *reports* the result instead of asserting "dev
// dependencies are not distributed", which for this container is not true.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const NODE_MODULES = 'node_modules/';

/** `node_modules/a/node_modules/@scope/b` -> `@scope/b` */
function nameFromPath(lockPath) {
  const index = lockPath.lastIndexOf(NODE_MODULES);
  return index === -1 ? lockPath : lockPath.slice(index + NODE_MODULES.length);
}

/**
 * Is this entry reachable only through a dev dependency?
 *
 * npm does not always flag a nested entry: `node_modules/playwright/node_modules/fsevents`
 * carries `optional: true` and NO `dev` flag, even though `node_modules/playwright`
 * itself is `dev: true`. Read literally, the lockfile therefore claims a
 * dev-only package is a production one — and it is a *platform-specific*
 * optional (darwin), so it never appears in `npm ls` on a Linux runner either.
 * That single row is what made the SBOM and the licence inventory disagree by
 * one package, which is the sort of discrepancy a reviewer notices and nobody
 * can explain a year later.
 *
 * A nested package is only reachable through its parent, so an entry under a
 * dev-marked ancestor is dev regardless of its own flags.
 */
function isUnderDevParent(lock, lockPath) {
  const parts = lockPath.split('/node_modules/');
  let prefix = parts[0];
  for (let index = 1; index < parts.length; index += 1) {
    const ancestor = lock.packages[prefix];
    if (ancestor && (ancestor.dev || ancestor.devOptional)) return true;
    prefix = `${prefix}/node_modules/${parts[index]}`;
  }
  return false;
}

/** Fallback for a lockfile entry with no `license`: the installed manifest. */
function licenseFromDisk(root, lockPath) {
  const manifest = path.join(root, lockPath, 'package.json');
  if (!existsSync(manifest)) return null;
  try {
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    if (typeof pkg.license === 'string') return pkg.license;
    // npm's long-dead `licenses: [{type}]` array, still in a few old packages.
    if (Array.isArray(pkg.licenses)) {
      const types = pkg.licenses.map((entry) => entry?.type).filter(Boolean);
      if (types.length) return types.length === 1 ? types[0] : `(${types.join(' OR ')})`;
    }
    if (pkg.license && typeof pkg.license === 'object' && pkg.license.type) return pkg.license.type;
  } catch {
    /* an unreadable manifest is the same as an absent one: unknown */
  }
  return null;
}

/**
 * Read the production tree.
 *
 * Returns `{ packages, devPackages, devCount, keys }`. `packages` is one entry
 * per *installation path* (the same package can legitimately appear at several,
 * occasionally at different versions) and `keys` is the set of `name@version`
 * strings, for callers that only need membership.
 *
 * Throws with a readable message rather than returning something empty: a
 * caller that gets zero packages back would report a clean bill of health.
 */
export function readProductionTree(root) {
  const lockfile = path.join(root, 'package-lock.json');
  if (!existsSync(lockfile)) {
    throw new Error('package-lock.json is missing — there is no dependency tree to read');
  }

  let lock;
  try {
    lock = JSON.parse(readFileSync(lockfile, 'utf8'));
  } catch (error) {
    throw new Error(`package-lock.json is not valid JSON: ${error.message}`);
  }

  if (!(lock.lockfileVersion >= 3) || !lock.packages) {
    throw new Error(
      `package-lock.json is lockfileVersion ${lock.lockfileVersion}; this needs v3 (npm 9+), which is where per-package \`license\` and \`dev\` live`,
    );
  }

  const packages = [];
  const devPackages = [];

  for (const [lockPath, entry] of Object.entries(lock.packages)) {
    if (lockPath === '') continue; // the root project itself
    if (entry.link) continue; // a workspace symlink, not a third-party package

    const record = {
      name: entry.name || nameFromPath(lockPath),
      version: entry.version || '(unpinned)',
      path: lockPath,
      license:
        (typeof entry.license === 'string' && entry.license) ||
        (entry.license && typeof entry.license === 'object' && entry.license.type) ||
        licenseFromDisk(root, lockPath) ||
        null,
    };

    // `devOptional` means "reachable only as a dev dependency or an optional
    // one of a dev dependency".
    if (entry.dev || entry.devOptional || isUnderDevParent(lock, lockPath)) {
      devPackages.push(record);
      continue;
    }
    packages.push(record);
  }

  if (packages.length === 0) {
    throw new Error(
      'the lockfile yielded zero production dependencies — the parser is broken, not the tree',
    );
  }

  return {
    packages,
    devPackages,
    devCount: devPackages.length,
    keys: new Set(packages.map((pkg) => `${pkg.name}@${pkg.version}`)),
  };
}
