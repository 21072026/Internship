// Shared release-fragment logic (#1275; per-change versions added in #1457).
// Used from four places, so it lives in one file with no dependencies:
//   - next.config.js              -> the build's version + the pending entries
//   - scripts/release-compact.mjs -> fold fragments into the canonical files
//   - scripts/check-release-fragments.mjs -> the CI gate
//   - e2e/version-release-notes.spec.ts   -> the expected footer version
//
// A "fragment" is releases/unreleased/<slug>.json:
//   {
//     "bump": "minor" | "patch",
//     "changelog": "- **Title** (#issue). Developer-facing markdown bullet.",
//     "notes": { "en": ["..."], "tr": ["..."], "de": ["..."] }   // optional
//   }
// PRs only ever ADD such files — they never touch package.json, CHANGELOG.md
// or src/lib/releaseNotes.ts, so parallel PRs cannot collide on version
// numbers or conflict on the same lines (see releases/README.md).
//
// ONE FRAGMENT = ONE RELEASE (#1457). Every fragment gets its own version, and
// that version is stamped with WHEN it shipped and WHICH commit brought it in.
// Before #1457 a whole compaction window collapsed into a single CHANGELOG
// section: the 2026-08-24 compaction wrote ~25 bullets under one heading and
// the versions 0.86.0-beta … 0.110.0-beta — which the running app had actually
// displayed, one per merge — were never recorded anywhere.
//
// The order is the MERGE order, read from git (the commit that ADDED the
// fragment file), not the filename order — that is what makes the version in
// the changelog equal the version the app displayed when that change went
// live. Filename order is the documented fallback for the contexts that have
// no git history (see resolveStamps).

const { readFileSync, readdirSync, existsSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const FRAGMENT_DIR = path.join('releases', 'unreleased');
const LOCALES = ['en', 'tr', 'de'];
/** Env var carrying pre-computed stamps into a context without .git (the
 *  Docker build: .dockerignore excludes .git, so `git log` is not an option
 *  there — build-image.yml computes this on the runner and passes it in). */
const STAMPS_ENV = 'RELEASE_STAMPS';

/** All fragments, sorted by filename (a stable, git-free base order). */
function readFragments(repoRoot) {
  const dir = path.join(repoRoot, FRAGMENT_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((file) => ({
      file,
      ...JSON.parse(readFileSync(path.join(dir, file), 'utf8')),
    }));
}

/** Throws with a readable message when a fragment is malformed. */
function validateFragment(fragment) {
  const where = fragment.file || '(inline)';
  if (!['minor', 'patch'].includes(fragment.bump)) {
    throw new Error(`${where}: "bump" must be "minor" or "patch"`);
  }
  if (typeof fragment.changelog !== 'string' || !fragment.changelog.trim()) {
    throw new Error(`${where}: "changelog" must be a non-empty string`);
  }
  if (fragment.notes !== undefined) {
    for (const locale of LOCALES) {
      const list = fragment.notes?.[locale];
      if (!Array.isArray(list) || list.length === 0 || list.some((s) => typeof s !== 'string' || !s.trim())) {
        throw new Error(`${where}: "notes.${locale}" must be a non-empty array of strings (all of ${LOCALES.join('/')} are required together)`);
      }
    }
    const extra = Object.keys(fragment.notes).filter((k) => !LOCALES.includes(k));
    if (extra.length) throw new Error(`${where}: unknown notes locale(s): ${extra.join(', ')}`);
  }
  const known = ['file', 'bump', 'changelog', 'notes'];
  const unknown = Object.keys(fragment).filter((k) => !known.includes(k));
  if (unknown.length) throw new Error(`${where}: unknown field(s): ${unknown.join(', ')}`);
}

/** git, quietly: '' instead of a throw when git or the repo is missing. */
function git(repoRoot, args) {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

/**
 * The commits a shallow clone was cut at. On such a clone `git log
 * --diff-filter=A` reports the boundary commit as the one that "added" every
 * file it carries, so a stamp pointing at it is a lie — refuse it rather than
 * record a wrong date and sha (CI checkouts are shallow by default; the two
 * workflows that stamp use fetch-depth: 0).
 */
function shallowBoundary(repoRoot) {
  const gitDir = git(repoRoot, ['rev-parse', '--git-dir']);
  if (!gitDir) return new Set();
  const abs = path.isAbsolute(gitDir) ? gitDir : path.join(repoRoot, gitDir);
  const file = path.join(abs, 'shallow');
  if (!existsSync(file)) return new Set();
  return new Set(readFileSync(file, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean));
}

/**
 * { <fragment file>: { sha, unix } } for every fragment whose add-commit is
 * knowable. Three sources, in order:
 *   1. process.env.RELEASE_STAMPS — a JSON map, for builds without .git
 *      (build-image.yml computes it on the runner and passes it in);
 *   2. one `git log --diff-filter=A` pass over the fragment directory;
 *   3. nothing — an unstamped fragment keeps filename order and reports no
 *      date/commit (the normal case for the fragment you just wrote locally,
 *      which is not committed yet, and for a `docker build` run by hand).
 *
 * ONE git pass, walked oldest-first, so a name that was added, compacted away
 * and later re-used ends up stamped with its most recent add. `--topo-order`
 * rather than date order: committer dates here carry local offsets (laptop
 * clocks), history order does not.
 */
function resolveStamps(repoRoot, fragments, env = process.env) {
  const fromEnv = env[STAMPS_ENV];
  if (fromEnv && fromEnv.trim()) {
    try {
      const parsed = JSON.parse(fromEnv);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // A malformed hand-set env var must not fail the build — fall through.
    }
  }
  if (!git(repoRoot, ['rev-parse', '--git-dir'])) return {};
  const boundary = shallowBoundary(repoRoot);
  const wanted = new Set(fragments.map((f) => f.file));
  const log = git(repoRoot, [
    'log', '--reverse', '--topo-order', '--diff-filter=A',
    '--format=C%H%x09%ct', '--name-only', '--', FRAGMENT_DIR,
  ]);
  const stamps = {};
  let order = 0;
  let commit = null;
  for (const line of log.split('\n')) {
    if (line.startsWith('C') && line.includes('\t')) {
      const [sha, unix] = line.slice(1).split('\t');
      commit = boundary.has(sha) ? null : { sha, unix: Number(unix) };
      continue;
    }
    const file = line.trim() ? path.basename(line.trim()) : '';
    if (!commit || !file || !wanted.has(file)) continue;
    stamps[file] = { ...commit, order: (order += 1) };
  }
  return stamps;
}

/**
 * Compaction must not invent history: a fragment that is committed but carries
 * no stamp would be written into the changelog with today's date and no commit,
 * silently disagreeing with what actually shipped. That happens when the
 * checkout is shallow (see shallowBoundary) — so fail loudly instead, naming
 * the fix. An UNcommitted fragment is fine: it has no history yet.
 */
function assertStamped(repoRoot, fragments, stamps) {
  const unstamped = fragments.filter((f) => !stamps[f.file]);
  if (unstamped.length === 0) return;
  const tracked = unstamped.filter((f) =>
    git(repoRoot, ['ls-files', '--', path.join(FRAGMENT_DIR, f.file)])
  );
  if (tracked.length === 0) return;
  throw new Error(
    `no add-commit found for committed fragment(s): ${tracked.map((f) => f.file).join(', ')}. ` +
      'A shallow clone cannot date a release — check out with fetch-depth: 0 ' +
      `(or pass ${STAMPS_ENV}).`
  );
}

/** Sort key of one stamp: unstamped fragments (= not committed yet, so newest
 *  by definition) sort last. */
function rank(stamp) {
  if (!stamp) return Number.POSITIVE_INFINITY;
  return typeof stamp.order === 'number' ? stamp.order : stamp.unix;
}

/** Fragments in merge order: stamped ones oldest-first, unstamped last,
 *  filename as the tie-break. */
function orderFragments(fragments, stamps = {}) {
  return [...fragments]
    .map((fragment) => ({ ...fragment, stamp: stamps[fragment.file] }))
    .sort((a, b) => {
      // History order when git gave us one, committer date when the stamps came
      // from RELEASE_STAMPS, filename as the final tie-break (two fragments in
      // one squash commit, or nothing stamped at all).
      const ka = rank(a.stamp);
      const kb = rank(b.stamp);
      if (ka !== kb) return ka - kb;
      return a.file < b.file ? -1 : a.file > b.file ? 1 : 0;
    });
}

/** Apply one bump to a semver (a suffix like "-beta" is preserved). */
function bumpVersion(version, bump) {
  const m = version.match(/^(\d+)\.(\d+)\.(\d+)(-.*)?$/);
  if (!m) throw new Error(`unparseable base version: ${version}`);
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const suffix = m[4] ?? '';
  return bump === 'minor'
    ? `${major}.${minor + 1}.0${suffix}`
    : `${major}.${minor}.${patch + 1}${suffix}`;
}

/** UTC date + time of a unix timestamp, as the changelog and the release
 *  notes show them ('2026-08-25', '09:15'). UTC on purpose: the repo's
 *  committers are in several time zones and a release timeline that mixes
 *  them cannot be read in order. */
function utcStamp(unix) {
  const iso = new Date(unix * 1000).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16), iso };
}

/**
 * One release per fragment, oldest first: the base version bumped once per
 * fragment in merge order, each entry carrying its own version, the date/time
 * it shipped and the commit that brought it in.
 *
 * [{ file, bump, changelog, notes?, version, date?, time?, iso?, commit? }]
 */
function releaseTimeline(baseVersion, fragments, stamps = {}) {
  let version = baseVersion;
  return orderFragments(fragments, stamps).map((fragment) => {
    version = bumpVersion(version, fragment.bump);
    const when = fragment.stamp ? utcStamp(fragment.stamp.unix) : null;
    return {
      file: fragment.file,
      bump: fragment.bump,
      changelog: fragment.changelog,
      notes: fragment.notes,
      version,
      date: when ? when.date : '',
      time: when ? when.time : '',
      iso: when ? when.iso : '',
      commit: fragment.stamp ? fragment.stamp.sha.slice(0, 7) : '',
      sha: fragment.stamp ? fragment.stamp.sha : '',
    };
  });
}

/**
 * The version a build carries: the base plus one bump per pending fragment.
 * Equal to the last entry of the timeline, so the number a build shows is
 * always the number the changelog will record for the newest change.
 */
function deriveVersion(baseVersion, fragments, stamps = {}) {
  const timeline = releaseTimeline(baseVersion, fragments, stamps);
  return timeline.length ? timeline[timeline.length - 1].version : baseVersion;
}

/**
 * Read + validate + stamp in one call — everything a caller needs.
 * `requireStamps` makes a committed-but-undatable fragment an error instead of
 * a silent fallback; compaction sets it, a build does not (a build only needs
 * the number, and a developer's uncommitted fragment must not break `npm run
 * build`).
 */
function resolveRelease(repoRoot, baseVersion, env = process.env, { requireStamps = false } = {}) {
  const fragments = readFragments(repoRoot);
  fragments.forEach(validateFragment);
  const stamps = resolveStamps(repoRoot, fragments, env);
  if (requireStamps) assertStamped(repoRoot, fragments, stamps);
  const timeline = releaseTimeline(baseVersion, fragments, stamps);
  return {
    fragments,
    stamps,
    timeline,
    version: timeline.length ? timeline[timeline.length - 1].version : baseVersion,
  };
}

/**
 * The pending timeline as release-notes entries, newest first — one entry per
 * fragment that carries user-facing notes (fragments without `notes` are
 * developer-facing and appear only in the changelog).
 */
function unreleasedEntries(timeline) {
  return timeline
    .filter((entry) => entry.notes)
    .map((entry) => ({
      version: entry.version,
      date: entry.date,
      time: entry.time,
      commit: entry.commit,
      highlights: entry.notes,
    }))
    .reverse();
}

module.exports = {
  FRAGMENT_DIR,
  LOCALES,
  STAMPS_ENV,
  readFragments,
  validateFragment,
  resolveStamps,
  assertStamped,
  orderFragments,
  bumpVersion,
  utcStamp,
  releaseTimeline,
  deriveVersion,
  resolveRelease,
  unreleasedEntries,
};

// CLI: `node scripts/release-derive.cjs --stamps` prints the stamp map as one
// line of JSON, for the workflow that has to hand it to a Docker build.
if (require.main === module) {
  const root = process.cwd();
  const fragments = readFragments(root);
  if (process.argv.includes('--stamps')) {
    process.stdout.write(JSON.stringify(resolveStamps(root, fragments, {})));
  } else {
    const base = require(path.join(root, 'package.json')).version;
    for (const e of releaseTimeline(base, fragments, resolveStamps(root, fragments))) {
      process.stdout.write(`${e.version}\t${e.date || '(unstamped)'} ${e.time}\t${e.commit || '-'}\t${e.file}\n`);
    }
  }
}
