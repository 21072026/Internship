// The lockfile half of a release (#2243).
//
// WHY THIS EXISTS
//   npm stores the package's own version in package-lock.json twice, and
//   rewrites both from package.json on every install. Compaction moved
//   package.json alone, so main drifted 16 minor versions ahead of its lockfile
//   and `npm install` on a clean checkout produced a two-line change nobody
//   made — in every contributor's `git status`, in every PR that touched
//   dependencies.
//
//   Two properties are asserted here and nowhere else:
//     - the write is TARGETED. A JSON round-trip of an ~800 KB file would
//       "work" and bury the real change, so the end-to-end test below runs the
//       real compaction in a throwaway git repo and asserts `git diff` reports
//       exactly 2 changed lines.
//     - the anchors cannot hit a dependency. The fixture deliberately contains
//       a dependency sitting at the same version string as the app.
//
// USAGE
//   npm run test:release   (also picked up by npm run test:unit)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { lockfileVersions, setLockfileVersion, syncLockfileVersion, FIX_COMMAND } = require('../release-lockfile.cjs');

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A lockfile in npm's exact shape, small enough to read in a failure message.
 *  `left-pad` carries the SAME version as the app on purpose. */
const lockfile = (version) => `{
  "name": "internship-crm",
  "version": "${version}",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {
      "name": "internship-crm",
      "version": "${version}",
      "hasInstallScript": true,
      "license": "AGPL-3.0-or-later",
      "dependencies": {
        "left-pad": "${version}"
      }
    },
    "node_modules/left-pad": {
      "version": "${version}",
      "resolved": "https://registry.npmjs.org/left-pad/-/left-pad-${version}.tgz",
      "license": "WTFPL"
    }
  }
}
`;

test('lockfileVersions reads both places npm keeps the version', () => {
  assert.deepEqual(lockfileVersions(lockfile('1.0.0')), { top: '1.0.0', root: '1.0.0' });
  assert.deepEqual(lockfileVersions('{"name":"x"}'), { top: undefined, root: undefined });
});

test('setLockfileVersion rewrites exactly the two version lines', () => {
  const before = lockfile('1.0.0');
  const after = setLockfileVersion(before, { name: 'internship-crm', from: '1.0.0', to: '1.1.0' });

  assert.deepEqual(lockfileVersions(after), { top: '1.1.0', root: '1.1.0' });
  const changed = after
    .split('\n')
    .map((line, i) => (line === before.split('\n')[i] ? null : i))
    .filter((i) => i !== null);
  assert.equal(changed.length, 2, `expected 2 changed lines, got ${changed.length}`);
});

test('a dependency at the same version is left alone', () => {
  const after = setLockfileVersion(lockfile('1.0.0'), { name: 'internship-crm', from: '1.0.0', to: '2.0.0' });
  const dep = JSON.parse(after).packages['node_modules/left-pad'];
  assert.equal(dep.version, '1.0.0', 'the anchors must not reach a dependency');
  assert.match(after, /left-pad-1\.0\.0\.tgz/);
  // ...and the root entry's own dependency RANGE is equally untouched.
  assert.equal(JSON.parse(after).packages[''].dependencies['left-pad'], '1.0.0');
});

test('setLockfileVersion refuses rather than guessing', () => {
  // Wrong starting version: better to stop than to write a lockfile whose two
  // fields disagree with each other.
  assert.throws(
    () => setLockfileVersion(lockfile('1.0.0'), { name: 'internship-crm', from: '0.9.0', to: '1.1.0' }),
    /could not find the top-level "version": "0\.9\.0"/
  );
  assert.throws(
    () => setLockfileVersion(lockfile('1.0.0'), { name: 'other-app', from: '1.0.0', to: '1.1.0' }),
    /could not find/
  );
  assert.throws(() => setLockfileVersion(lockfile('1.0.0'), { name: 'internship-crm', from: '1.0.0' }), /required/);
  // A no-op is a no-op, byte for byte.
  const same = lockfile('1.0.0');
  assert.equal(setLockfileVersion(same, { name: 'internship-crm', from: '1.0.0', to: '1.0.0' }), same);
});

test('syncLockfileVersion pulls the lockfile up to package.json', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'release-lockfile-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'internship-crm', version: '2.0.0' }, null, 2));
  writeFileSync(path.join(root, 'package-lock.json'), lockfile('1.0.0'));

  assert.deepEqual(syncLockfileVersion(root), { changed: true, from: '1.0.0', to: '2.0.0' });
  assert.deepEqual(lockfileVersions(readFileSync(path.join(root, 'package-lock.json'), 'utf8')), {
    top: '2.0.0',
    root: '2.0.0',
  });
  // Idempotent: this is what `npm run fix:lockfile-version` costs on a clean tree.
  assert.deepEqual(syncLockfileVersion(root), { changed: false, from: '2.0.0', to: '2.0.0' });
  assert.equal(FIX_COMMAND, 'npm run fix:lockfile-version');
});

// --- the real script, in a throwaway repository: the only place the 2-line
// --- promise can actually be measured, because it is measured with git.
test('a compaction moves the lockfile with package.json, in a 2-line diff', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'release-compact-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: '2026-09-01T10:00:00+0000',
        GIT_COMMITTER_DATE: '2026-09-01T10:00:00+0000',
      },
    });

  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(
    path.join(root, 'package.json'),
    `${JSON.stringify({ name: 'internship-crm', version: '1.0.0', scripts: {} }, null, 2)}\n`
  );
  writeFileSync(path.join(root, 'package-lock.json'), lockfile('1.0.0'));
  writeFileSync(path.join(root, 'CHANGELOG.md'), '# Changelog\n\n## [1.0.0] - 2026-01-01\n\n- first\n');
  mkdirSync(path.join(root, 'releases', 'unreleased'), { recursive: true });
  writeFileSync(
    path.join(root, 'releases', 'unreleased', 'a-fix.json'),
    JSON.stringify({ bump: 'patch', changelog: '- fixed a thing' })
  );
  git('add', '-A');
  git('commit', '-q', '-m', 'add fragment');

  const out = execFileSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'release-compact.mjs')], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.match(out, /-> 1\.0\.1/);

  // package.json moved...
  assert.equal(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version, '1.0.1');
  // ...and so did BOTH lockfile fields, which is the whole point.
  assert.deepEqual(lockfileVersions(readFileSync(path.join(root, 'package-lock.json'), 'utf8')), {
    top: '1.0.1',
    root: '1.0.1',
  });
  assert.equal(existsSync(path.join(root, 'releases', 'unreleased', 'a-fix.json')), false);

  // The measurement that a JSON round-trip would fail: 2 added, 2 removed.
  const numstat = git('diff', '--numstat', '--', 'package-lock.json').trim();
  assert.equal(numstat, '2\t2\tpackage-lock.json', `lockfile diff was not 2 lines:\n${numstat}`);
});

test('a compaction run on a lockfile that is already in step is still fine', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'release-compact-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_AUTHOR_DATE: '2026-09-01T10:00:00+0000', GIT_COMMITTER_DATE: '2026-09-01T10:00:00+0000' },
    });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({ name: 'internship-crm', version: '1.0.0' }, null, 2)}\n`);
  // Already ahead: the version the fragment will produce. `from` therefore
  // cannot be assumed to be package.json's version — the script must notice.
  writeFileSync(path.join(root, 'package-lock.json'), lockfile('1.0.1'));
  writeFileSync(path.join(root, 'CHANGELOG.md'), '# Changelog\n\n## [1.0.0] - 2026-01-01\n\n- first\n');
  mkdirSync(path.join(root, 'releases', 'unreleased'), { recursive: true });
  writeFileSync(path.join(root, 'releases', 'unreleased', 'a-fix.json'), JSON.stringify({ bump: 'patch', changelog: '- x' }));
  git('add', '-A');
  git('commit', '-q', '-m', 'add fragment');

  execFileSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'release-compact.mjs')], { cwd: root, encoding: 'utf8' });
  assert.equal(git('diff', '--numstat', '--', 'package-lock.json').trim(), '', 'nothing to rewrite, nothing rewritten');
});
