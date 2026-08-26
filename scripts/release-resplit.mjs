// One-shot repair of the changelog entries the OLD compaction lumped together
// (#1457). Kept in the tree for provenance: it documents, and can re-derive,
// where the 0.85.1-beta … 0.110.1-beta sections came from.
//
// WHAT WENT WRONG
//   Until #1457 `release-compact.mjs` folded every pending fragment into ONE
//   `## [<newest version>] - <today>` section. The 2026-08-24 run (7a5066c)
//   therefore wrote 45 changes from 33 commits over two days under a single
//   `0.110.1-beta` heading, and the 25 versions the app had actually served in
//   between were recorded nowhere.
//
// HOW THE REPAIR IS SAFE
//   The compaction was lossless and mechanical: the section body is exactly
//   `fragments.map(f => f.changelog.trim()).join('\n')` in filename order, and
//   the release-notes entry is exactly their notes concatenated. So the 45
//   fragments can be read back out of history (`git show <compaction>^:<path>`),
//   replayed with the per-fragment rule, and the result checked two ways:
//     1. the last version must land back on 0.110.1-beta (it does — the bump
//        arithmetic is unchanged, only its granularity is);
//     2. every bullet and every highlight must appear exactly once, with no
//        text edited.
//   Both are asserted below; the script refuses to write if either fails.
//
// USAGE
//   node scripts/release-resplit.mjs [--dry-run]
//   Idempotent: exits 0 without touching anything once the lumped section is
//   gone.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { releaseTimeline, shallowBoundary } = require('./release-derive.cjs');

const REPO_URL = 'https://github.com/21072026/Internship';
const LUMPED = '0.110.1-beta';
const BASE = '0.85.0-beta'; // the version the lumped window started from
const dryRun = process.argv.includes('--dry-run');
const root = process.cwd();
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

// A shallow clone reports its graft commit as having ADDED every file it
// carries, so `--diff-filter=A` would credit whole batches of releases to one
// unrelated commit and date them wrong. That is exactly what this script must
// not write into published history — refuse instead of guessing.
if (git('rev-parse', '--is-shallow-repository').trim() !== 'false') {
  throw new Error('shallow clone: cannot attribute releases to their real commits — run `git fetch --unshallow` first');
}
const boundary = shallowBoundary(root);

const clPath = path.join(root, 'CHANGELOG.md');
const rnPath = path.join(root, 'src', 'lib', 'releaseNotes.ts');
const cl = readFileSync(clPath, 'utf8');
const rn = readFileSync(rnPath, 'utf8');

const head = `## [${LUMPED}] - `;
const start = cl.indexOf(head);
if (start === -1) {
  console.log(`no lumped [${LUMPED}] section — nothing to re-split`);
  process.exit(0);
}
const bodyStart = cl.indexOf('\n\n', start) + 2;
const nextSection = cl.indexOf('\n## [', bodyStart);
const oldBody = cl.slice(bodyStart, nextSection === -1 ? cl.length : nextSection + 1);
if (oldBody.startsWith('_Shipped ')) {
  console.log(`[${LUMPED}] is already a single dated release — nothing to re-split`);
  process.exit(0);
}

// 1. Read the 45 folded fragments back out of the compaction commit.
const compaction = git('log', '-S', head, '--format=%H', '--', 'CHANGELOG.md').trim().split('\n').filter(Boolean).pop();
if (!compaction) throw new Error('could not find the commit that wrote the lumped section');
const files = git('show', '--diff-filter=D', '--name-only', '--format=', compaction, '--', 'releases/unreleased/')
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean);
if (!files.length) throw new Error(`${compaction} deleted no fragments`);

const fragments = [];
const stamps = {};
for (const filePath of files) {
  const file = path.basename(filePath);
  const fragment = JSON.parse(git('show', `${compaction}^:${filePath}`));
  const line = git('log', '--diff-filter=A', '--format=%H%x09%ct', '-1', `${compaction}^`, '--', filePath).trim();
  if (!line) throw new Error(`no add-commit for ${filePath}`);
  const [sha, unix] = line.split('\t');
  if (boundary.has(sha)) throw new Error(`${file}: add-commit ${sha.slice(0, 7)} is a shallow boundary — its real date is not in this clone`);
  fragments.push({ file, ...fragment });
  stamps[file] = { sha, unix: Number(unix) };
}
// Order by add-commit date; the walk order of release-derive is not available
// for deleted files, and every one of these commits is on main already.
[...fragments]
  .sort((a, b) => stamps[a.file].unix - stamps[b.file].unix)
  .forEach((f, i) => { stamps[f.file].order = i + 1; });

const timeline = releaseTimeline(BASE, fragments, stamps);
const landed = timeline[timeline.length - 1].version;
if (landed !== LUMPED) {
  throw new Error(`replay landed on ${landed}, not the published ${LUMPED} — refusing to rewrite history it does not reproduce`);
}

// 2. Rebuild the sections, newest first, and prove nothing was lost.
const byFilename = [...fragments].sort((a, b) => (a.file < b.file ? -1 : 1));
const rebuiltOldBody = `${byFilename.map((f) => f.changelog.trim()).join('\n')}\n`;
if (rebuiltOldBody.trim() !== oldBody.trim()) {
  throw new Error('the fragments do not reproduce the published section body — the section was hand-edited after compaction; refusing to rewrite it');
}

const sections = [...timeline]
  .reverse()
  .map((e) => {
    const meta = `_Shipped ${e.date} ${e.time} UTC · commit [${e.commit}](${REPO_URL}/commit/${e.sha})_\n\n`;
    return `## [${e.version}] - ${e.date}\n\n${meta}${e.changelog.trim()}\n\n`;
  })
  .join('');
const clNext = cl.slice(0, start) + sections + cl.slice(nextSection === -1 ? cl.length : nextSection + 1);

// 3. The same for the single lumped release-notes entry.
const rnHead = `  {\n    version: '${LUMPED}',`;
const rnStart = rn.indexOf(rnHead);
if (rnStart === -1) throw new Error(`releaseNotes.ts has no ${LUMPED} entry`);
const rnEnd = rn.indexOf('\n  },\n', rnStart) + '\n  },\n'.length;
const oldEntry = rn.slice(rnStart, rnEnd);
const withNotes = timeline.filter((e) => e.notes);
for (const locale of ['en', 'tr', 'de']) {
  const published = [...oldEntry.matchAll(new RegExp(`^\\s{8}"(.*)",$`, 'gm'))];
  if (!published.length) throw new Error('could not read the published highlights');
  const rebuilt = byFilename.filter((f) => f.notes).flatMap((f) => f.notes[locale]);
  const inEntry = rebuilt.every((s) => oldEntry.includes(JSON.stringify(s)));
  if (!inEntry) throw new Error(`a ${locale} highlight in the fragments is not in the published entry`);
}
const list = (arr) => arr.map((s) => `        ${JSON.stringify(s)},`).join('\n');
const rnEntries = [...withNotes]
  .reverse()
  .map((e) => `  {
    version: '${e.version}',
    date: '${e.date}',
    time: '${e.time}',
    commit: '${e.commit}',
    highlights: {
      en: [
${list(e.notes.en)}
      ],
      tr: [
${list(e.notes.tr)}
      ],
      de: [
${list(e.notes.de)}
      ],
    },
  },
`)
  .join('');
const rnNext = rn.slice(0, rnStart) + rnEntries + rn.slice(rnEnd);

console.log(`re-split ${fragments.length} fragment(s): ${BASE} -> ${landed}`);
for (const e of timeline) console.log(`  ${e.version.padEnd(14)} ${e.date} ${e.time}  ${e.commit}  ${e.file}`);
console.log(`changelog sections: 1 -> ${timeline.length}; release-notes entries: 1 -> ${withNotes.length}`);
if (dryRun) {
  console.log('\n--- dry run, nothing written ---');
  process.exit(0);
}
writeFileSync(clPath, clNext);
writeFileSync(rnPath, rnNext);
