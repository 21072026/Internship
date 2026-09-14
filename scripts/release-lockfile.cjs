// The version in package-lock.json (#2243).
//
// WHY THIS EXISTS
//   npm keeps the package's own version in the lockfile too — in TWO places,
//   the top-level `.version` and the root package entry `.packages[""].version`
//   — and rewrites both from package.json on every `npm install`. Compaction
//   (scripts/release-compact.mjs) bumped package.json only, so the gap widened
//   with every release: a clean checkout of main plus a plain `npm install`
//   left the tree dirty with a package-lock.json change nobody made, which is
//   noise in every diff and a trap for any workflow that asserts a clean tree.
//
// WHY A TARGETED STRING REPLACEMENT
//   JSON.parse + JSON.stringify would reserialise ~800 KB and bury the one-line
//   change under whatever key ordering and formatting the round-trip produced.
//   The write below touches exactly the two version lines, so the diff of a
//   compaction stays two lines. READING is the opposite case: JSON.parse is
//   exact and costs nothing visible, so the reader parses.
//
// Dependency-free CommonJS, like its siblings release-derive.cjs /
// release-media.cjs, because scripts/*.mjs require() it.
//
// Run directly to close a drift:
//   node scripts/release-lockfile.cjs --sync   (npm run fix:lockfile-version)

const { readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const LOCKFILE = 'package-lock.json';
const PACKAGE = 'package.json';

/** The command the guard tells you to run; stated once, quoted everywhere. */
const FIX_COMMAND = 'npm run fix:lockfile-version';

const escapeRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The two version fields npm keeps in a lockfile.
 * Reading parses: it is exact, and nothing is written back.
 * @returns {{ top: string|undefined, root: string|undefined }}
 */
function lockfileVersions(raw) {
  const json = JSON.parse(raw);
  return { top: json.version, root: json.packages && json.packages[''] && json.packages[''].version };
}

/**
 * Anchors for the two version lines. Both are pinned to the package's own name
 * (and the root entry additionally to its `""` key), so neither can match a
 * dependency that happens to sit at the same version string — there are ~900 of
 * those in this lockfile and several share the app's version by coincidence.
 */
function anchors(name, from) {
  const n = escapeRe(name);
  const v = escapeRe(from);
  return {
    // The head of the file: `{` then the root name/version pair.
    top: `^\\{\\n(\\s+)"name": "${n}",\\n\\1"version": "${v}",`,
    // Inside "packages", the entry keyed by the empty string is the package
    // itself; every other entry is keyed by a node_modules path.
    root: `\\n(\\s+)"": \\{\\n(\\s+)"name": "${n}",\\n\\2"version": "${v}",`,
  };
}

/**
 * Rewrite both version fields, touching nothing else.
 * Throws when an anchor is missing or ambiguous — a compaction that cannot
 * update the lockfile must fail loudly rather than silently widen the gap again.
 * @returns {string} the new lockfile text
 */
function setLockfileVersion(raw, { name, from, to }) {
  if (!name) throw new Error('setLockfileVersion: package name is required');
  if (!from || !to) throw new Error('setLockfileVersion: both from and to versions are required');
  if (from === to) return raw;

  let next = raw;
  for (const [which, source] of Object.entries(anchors(name, from))) {
    const hits = next.match(new RegExp(source, 'gm'));
    if (!hits) {
      throw new Error(
        `${LOCKFILE}: could not find the ${which}-level "version": "${from}" of "${name}". ` +
          `Is the lockfile at a different version than ${PACKAGE}? Run \`${FIX_COMMAND}\`.`
      );
    }
    if (hits.length > 1) throw new Error(`${LOCKFILE}: the ${which}-level version anchor matched ${hits.length} times`);
    next = next.replace(new RegExp(source, 'm'), (match) =>
      match.replace(`"version": "${from}"`, `"version": "${to}"`)
    );
  }
  return next;
}

/**
 * Bring package-lock.json in line with package.json's version, in place.
 * Used by the compaction (which has just written the new package.json) and by
 * `--sync`. Returns what it did so callers can log one honest line.
 * @returns {{ changed: boolean, from: string, to: string }}
 */
function syncLockfileVersion(root) {
  const pkgPath = path.join(root, PACKAGE);
  const lockPath = path.join(root, LOCKFILE);
  const { name, version: to } = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const raw = readFileSync(lockPath, 'utf8');
  const { top, root: rootVersion } = lockfileVersions(raw);
  if (top === to && rootVersion === to) return { changed: false, from: to, to };
  if (top !== rootVersion) {
    throw new Error(`${LOCKFILE}: its two version fields already disagree (${top} vs ${rootVersion}) — fix it by hand`);
  }
  writeFileSync(lockPath, setLockfileVersion(raw, { name, from: top, to }));
  return { changed: true, from: top, to };
}

module.exports = {
  LOCKFILE,
  PACKAGE,
  FIX_COMMAND,
  lockfileVersions,
  setLockfileVersion,
  syncLockfileVersion,
};

if (require.main === module) {
  if (!process.argv.includes('--sync')) {
    console.error(`usage: node scripts/release-lockfile.cjs --sync   (${FIX_COMMAND})`);
    process.exit(2);
  }
  const result = syncLockfileVersion(process.cwd());
  console.log(
    result.changed
      ? `${LOCKFILE}: version ${result.from} -> ${result.to} (2 lines)`
      : `${LOCKFILE}: already at ${result.to} — nothing to do`
  );
}
