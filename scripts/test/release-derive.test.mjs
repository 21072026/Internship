// Regression tests for the release-version arithmetic (#1457).
//
// WHY THIS EXISTS
//   These functions decide the version number every shipped change is recorded
//   under, and they run in three places that must agree: the build
//   (next.config.js), the CI gate (check-release-fragments.mjs) and the
//   compaction that writes CHANGELOG.md. When they disagreed nobody noticed for
//   two months: fragments were ordered by FILENAME, so a `patch` fragment whose
//   name sorted before the last `minor` fragment's name was erased by that
//   minor's patch=0 reset — three consecutive merges shipped under the same
//   version (0.114.0), and the compaction then buried all of them, and 42 more,
//   in one `## [0.110.1-beta]` section. Both properties are asserted below.
//
// USAGE
//   node --test scripts/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  bumpVersion,
  releaseTimeline,
  deriveVersion,
  orderFragments,
  resolveStamps,
  assertStamped,
  resolveRelease,
  unreleasedEntries,
  utcStamp,
  validateFragment,
} = require('../release-derive.cjs');

const frag = (file, bump, notes) => ({
  file,
  bump,
  changelog: `- ${file}`,
  ...(notes ? { notes: { en: [`en ${file}`], tr: [`tr ${file}`], de: [`de ${file}`] } } : {}),
});
/** Stamps in the shape the git walk produces: explicit history order. */
const stampsFor = (...files) =>
  Object.fromEntries(files.map((file, i) => [file, { sha: `${i}`.repeat(40), unix: 1700000000 + i * 60, order: i + 1 }]));

test('bumpVersion keeps the prerelease suffix and resets patch on a minor', () => {
  assert.equal(bumpVersion('0.110.1-beta', 'patch'), '0.110.2-beta');
  assert.equal(bumpVersion('0.110.1-beta', 'minor'), '0.111.0-beta');
  assert.equal(bumpVersion('1.2.3', 'minor'), '1.3.0');
  assert.throws(() => bumpVersion('not-a-version', 'patch'), /unparseable/);
});

test('every fragment gets its own version, in merge order', () => {
  const fragments = [frag('zzz.json', 'patch'), frag('aaa.json', 'minor')];
  // Merge order says zzz shipped first, even though aaa sorts first.
  const timeline = releaseTimeline('0.110.1-beta', fragments, stampsFor('zzz.json', 'aaa.json'));
  assert.deepEqual(
    timeline.map((e) => [e.file, e.version]),
    [['zzz.json', '0.110.2-beta'], ['aaa.json', '0.111.0-beta']]
  );
});

test('an earlier fragment keeps its version when a later one lands (prefix stability)', () => {
  const first = [frag('a.json', 'minor'), frag('b.json', 'patch')];
  const before = releaseTimeline('1.0.0', first, stampsFor('a.json', 'b.json'));
  const after = releaseTimeline('1.0.0', [...first, frag('c.json', 'minor')], stampsFor('a.json', 'b.json', 'c.json'));
  assert.deepEqual(before.map((e) => e.version), ['1.1.0', '1.1.1']);
  assert.deepEqual(after.map((e) => e.version), ['1.1.0', '1.1.1', '1.2.0']);
  // Which is what makes the number a build displays the number the changelog
  // will record: it depends only on the fragments that shipped before it.
  assert.equal(deriveVersion('1.0.0', first.slice(0, 1), stampsFor('a.json')), before[0].version);
});

test('REGRESSION: the version can no longer freeze across consecutive merges', () => {
  // The real pending set that exposed the bug: a minor, then three patches
  // whose filenames sort before it. Filename order froze all three on 1.1.0.
  const merged = [
    frag('growth-analytics.json', 'minor'),
    frag('a11y-gate.json', 'patch'),
    frag('custom-stages.json', 'patch'),
    frag('availability-tenant-scope.json', 'patch'),
  ];
  const perMerge = merged.map((_, i) => {
    const window = merged.slice(0, i + 1);
    const files = window.map((f) => f.file);
    return deriveVersion('1.0.0', window, stampsFor(...files));
  });
  assert.deepEqual(perMerge, ['1.1.0', '1.1.1', '1.1.2', '1.1.3']);
  assert.equal(new Set(perMerge).size, perMerge.length, 'every merge must move the version');

  // And the old rule really did freeze: the pending set grows in merge order
  // but was derived in filename order, so the three patches landed *before* the
  // minor and its patch=0 reset swallowed them. Unstamped fragments still take
  // that filename order, which is what this reproduces.
  const frozen = merged.map((_, i) => deriveVersion('1.0.0', merged.slice(0, i + 1)));
  assert.deepEqual(frozen, ['1.1.0', '1.1.0', '1.1.0', '1.1.0']);
});

test('an uncommitted fragment sorts last and reports no date or commit', () => {
  const fragments = [frag('committed.json', 'minor'), frag('local-wip.json', 'patch')];
  const timeline = releaseTimeline('1.0.0', fragments, stampsFor('committed.json'));
  assert.deepEqual(timeline.map((e) => e.file), ['committed.json', 'local-wip.json']);
  assert.equal(timeline[1].date, '');
  assert.equal(timeline[1].commit, '');
  assert.equal(timeline[1].version, '1.1.1');
});

test('two fragments in one commit share the stamp, ordered by filename', () => {
  const shared = { sha: 'd'.repeat(40), unix: 1787621796, order: 4 };
  const stamps = { 'b-second.json': shared, 'a-first.json': shared };
  const ordered = orderFragments([frag('b-second.json', 'patch'), frag('a-first.json', 'patch')], stamps);
  assert.deepEqual(ordered.map((f) => f.file), ['a-first.json', 'b-second.json']);
});

test('utcStamp renders UTC, never the local zone', () => {
  const { date, time } = utcStamp(1787649906); // 2026-08-25T09:25:06Z
  assert.equal(date, '2026-08-25');
  assert.equal(time, '09:25');
});

test('unreleasedEntries: newest first, only the changes users can see', () => {
  const timeline = releaseTimeline(
    '1.0.0',
    [frag('a.json', 'minor', true), frag('b.json', 'patch'), frag('c.json', 'minor', true)],
    stampsFor('a.json', 'b.json', 'c.json')
  );
  const entries = unreleasedEntries(timeline);
  assert.deepEqual(entries.map((e) => e.version), ['1.2.0', '1.1.0']);
  assert.deepEqual(entries[0].highlights.tr, ['tr c.json']);
});

test('RELEASE_STAMPS wins over git, and a bad value degrades instead of throwing', () => {
  const given = stampsFor('x.json');
  assert.deepEqual(resolveStamps('/nonexistent', [frag('x.json', 'patch')], { RELEASE_STAMPS: JSON.stringify(given) }), given);
  assert.deepEqual(resolveStamps('/nonexistent', [frag('x.json', 'patch')], { RELEASE_STAMPS: '{oops' }), {});
  assert.deepEqual(resolveStamps('/nonexistent', [frag('x.json', 'patch')], { RELEASE_STAMPS: '[1,2]' }), {});
  // Half-written entries are dropped, not fed to sha.slice() as a crash: this
  // value arrives from a shell substitution in build-image.yml.
  const fragments = [frag('a.json', 'patch'), frag('b.json', 'minor')];
  const mixed = JSON.stringify({
    'a.json': { sha: 'not-a-sha', unix: 1 },
    'b.json': { sha: 'abcdef1234', unix: 1700000000 },
  });
  const cleaned = resolveStamps('/nonexistent', fragments, { RELEASE_STAMPS: mixed });
  assert.deepEqual(Object.keys(cleaned), ['b.json']);
  const timeline = releaseTimeline('1.0.0', fragments, cleaned);
  assert.deepEqual(timeline.map((e) => [e.file, e.version, e.commit]), [
    ['b.json', '1.1.0', 'abcdef1'],
    ['a.json', '1.1.1', ''],
  ]);
});

test('validateFragment rejects the ways a fragment goes wrong', () => {
  assert.throws(() => validateFragment({ file: 'f.json', bump: 'major', changelog: 'x' }), /"bump"/);
  assert.throws(() => validateFragment({ file: 'f.json', bump: 'patch', changelog: '  ' }), /"changelog"/);
  assert.throws(
    () => validateFragment({ file: 'f.json', bump: 'patch', changelog: 'x', notes: { en: ['a'], tr: ['b'] } }),
    /notes\.de/
  );
  assert.throws(() => validateFragment({ file: 'f.json', bump: 'patch', changelog: 'x', extra: 1 }), /unknown field/);
});

// --- the git-backed half: a throwaway repository, so the real `git log` path
// --- is exercised rather than a mock of it.
function repoWith(commits) {
  const root = mkdtempSync(path.join(tmpdir(), 'release-derive-'));
  const run = (args, env) =>
    execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, ...env } });
  run(['init', '-q', '-b', 'main']);
  run(['config', 'user.email', 'test@example.com']);
  run(['config', 'user.name', 'Test']);
  mkdirSync(path.join(root, 'releases', 'unreleased'), { recursive: true });
  for (const { file, bump, committerDate, authorDate } of commits) {
    writeFileSync(
      path.join(root, 'releases', 'unreleased', file),
      JSON.stringify({ bump, changelog: `- ${file}` })
    );
    run(['add', '-A']);
    run(['commit', '-q', '-m', `add ${file}`], {
      GIT_AUTHOR_DATE: authorDate || committerDate,
      GIT_COMMITTER_DATE: committerDate,
    });
  }
  return { root, run };
}

test('a non-ASCII fragment name is still matched (git c-quotes paths by default)', (t) => {
  const { root } = repoWith([
    { file: 'mentör-atama.json', bump: 'patch', committerDate: '2026-08-01T10:00:00+0000' },
    { file: 'plain.json', bump: 'minor', committerDate: '2026-08-02T10:00:00+0000' },
  ]);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { timeline } = resolveRelease(root, '1.0.0', {}, { requireStamps: true });
  assert.deepEqual(
    timeline.map((e) => [e.file, e.version]),
    [['mentör-atama.json', '1.0.1'], ['plain.json', '1.1.0']]
  );
});

test('a renamed fragment is dated by the rename, not left undatable', (t) => {
  const { root, run } = repoWith([{ file: 'old-name.json', bump: 'minor', committerDate: '2026-08-01T10:00:00+0000' }]);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'releases', 'unreleased');
  run(['mv', path.join(dir, 'old-name.json'), path.join(dir, 'new-name.json')]);
  run(['commit', '-q', '-m', 'rename'], { GIT_COMMITTER_DATE: '2026-08-03T12:00:00+0000', GIT_AUTHOR_DATE: '2026-08-03T12:00:00+0000' });
  // Without --no-renames git reports a rename, not an addition, and the
  // fragment would look uncommitted — which sorts it last and renumbers what
  // already shipped. requireStamps would then block compaction forever.
  const { timeline } = resolveRelease(root, '1.0.0', {}, { requireStamps: true });
  assert.deepEqual(timeline.map((e) => [e.file, e.date]), [['new-name.json', '2026-08-03']]);
});

test('a new fragment reusing a compacted slug does not inherit the old release', (t) => {
  const { root, run } = repoWith([{ file: 'reused-slug.json', bump: 'minor', committerDate: '2026-08-01T10:00:00+0000' }]);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // Compaction consumes the fragment...
  run(['rm', '-q', path.join('releases', 'unreleased', 'reused-slug.json')]);
  run(['commit', '-q', '-m', 'compact'], { GIT_COMMITTER_DATE: '2026-08-02T10:00:00+0000', GIT_AUTHOR_DATE: '2026-08-02T10:00:00+0000' });
  // ...and months later the same slug is written again, not yet committed.
  mkdirSync(path.join(root, 'releases', 'unreleased'), { recursive: true }); // git rm took the empty dir
  writeFileSync(
    path.join(root, 'releases', 'unreleased', 'reused-slug.json'),
    JSON.stringify({ bump: 'patch', changelog: '- new work under an old name' })
  );
  const { timeline } = resolveRelease(root, '2.0.0', {});
  assert.equal(timeline[0].date, '', 'the 2026-08-01 add-commit must not be reused');
  assert.equal(timeline[0].commit, '');
});

test('git stamps come from the add-commit, ordered by history', (t) => {
  const { root } = repoWith([
    { file: 'zzz-first.json', bump: 'patch', committerDate: '2026-08-01T10:00:00+0000' },
    { file: 'aaa-second.json', bump: 'minor', committerDate: '2026-08-02T11:30:00+0000' },
  ]);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { timeline, version } = resolveRelease(root, '0.5.0-beta', {}, { requireStamps: true });
  assert.deepEqual(
    timeline.map((e) => [e.file, e.version, e.date, e.time]),
    [
      ['zzz-first.json', '0.5.1-beta', '2026-08-01', '10:00'],
      ['aaa-second.json', '0.6.0-beta', '2026-08-02', '11:30'],
    ]
  );
  assert.equal(version, '0.6.0-beta');
  assert.match(timeline[0].commit, /^[0-9a-f]{7}$/);
});

test('the MERGE date is used, not the date the branch was written', (t) => {
  // A squash merge stamps the committer date; the author date can be weeks old.
  // Author date would insert this change before ones that already shipped.
  const { root } = repoWith([
    { file: 'old-branch.json', bump: 'patch', authorDate: '2026-07-01T09:00:00+0000', committerDate: '2026-08-20T09:00:00+0000' },
  ]);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { timeline } = resolveRelease(root, '1.0.0', {});
  assert.equal(timeline[0].date, '2026-08-20');
});

test('compaction fails closed on a committed fragment it cannot date', (t) => {
  const { root, run } = repoWith([{ file: 'committed.json', bump: 'patch', committerDate: '2026-08-01T10:00:00+0000' }]);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fragments = [{ file: 'committed.json', bump: 'patch', changelog: '- x' }];
  // Simulating the shallow-clone case: the fragment is tracked, no stamp found.
  assert.throws(() => assertStamped(root, fragments, {}), /fetch-depth: 0/);
  // An uncommitted one is fine — it has no history to read yet.
  writeFileSync(path.join(root, 'releases', 'unreleased', 'wip.json'), '{}');
  assertStamped(root, [{ file: 'wip.json', bump: 'patch', changelog: '- x' }], {});
  run(['status', '--short']);
});
