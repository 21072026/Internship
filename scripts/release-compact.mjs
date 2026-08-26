// Fold the pending release fragments into the three canonical files (#1275),
// ONE RELEASE PER FRAGMENT (#1457):
//   package.json            -> version = the newest fragment's version
//   CHANGELOG.md            -> one section per fragment: its own version, the
//                              date/time it shipped and the commit that
//                              brought it in
//   src/lib/releaseNotes.ts -> one entry per fragment that carries notes
// then delete the fragments. Run by .github/workflows/release-compact.yml on a
// schedule (the result goes through a NORMAL pull request — branch protection
// stays intact), or by hand:
//   node scripts/release-compact.mjs [--dry-run]
//
// Before #1457 this script wrote a SINGLE section holding every pending
// fragment's bullet, headed with the newest version — so the 2026-08-24 run
// buried ~25 changes under `## [0.110.1-beta]` and the intermediate versions
// the app had actually served (0.86 … 0.110) were never recorded. The dates and
// commits come from git (the commit that added each fragment), which is why the
// workflow checks out with fetch-depth: 0.
//
// Idempotent by construction: no fragments -> exit 0 without touching anything.
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { FRAGMENT_DIR, resolveRelease } = require('./release-derive.cjs');

// The public repository, for the commit links in the changelog. Same URL as
// src/components/landing/links.ts (a .mjs script cannot import the TS module).
const REPO_URL = 'https://github.com/21072026/Internship';

const dryRun = process.argv.includes('--dry-run');
const root = process.cwd();
const pkgPath = path.join(root, 'package.json');
const pkgRaw = readFileSync(pkgPath, 'utf8');
const pkg = JSON.parse(pkgRaw);

// requireStamps: never write a release section that invents its own date.
const { timeline } = resolveRelease(root, pkg.version, process.env, { requireStamps: true });
if (timeline.length === 0) {
  console.log('no pending fragments — nothing to compact');
  process.exit(0);
}

const version = timeline[timeline.length - 1].version;
const today = new Date().toISOString().slice(0, 10);
// Newest first, the order both canonical files are read in.
const newestFirst = [...timeline].reverse();

// 1. package.json — replace exactly the version line, preserving formatting.
const pkgNext = pkgRaw.replace(`"version": "${pkg.version}"`, `"version": "${version}"`);
if (pkgNext === pkgRaw) throw new Error(`could not find "version": "${pkg.version}" in package.json`);

// 2. CHANGELOG.md — one section per fragment, newest first.
const clPath = path.join(root, 'CHANGELOG.md');
const cl = readFileSync(clPath, 'utf8');
const anchor = cl.indexOf('## [');
if (anchor === -1) throw new Error('CHANGELOG.md has no "## [" section to anchor on');
const sections = newestFirst
  .map((entry) => {
    // A fragment whose add-commit is unknown (compacted before it was
    // committed) still gets its own section — dated today, with no meta line,
    // because inventing a commit would be worse than omitting one.
    const meta = entry.sha
      ? `_Shipped ${entry.date} ${entry.time} UTC · commit [${entry.commit}](${REPO_URL}/commit/${entry.sha})_\n\n`
      : '';
    return `## [${entry.version}] - ${entry.date || today}\n\n${meta}${entry.changelog.trim()}\n\n`;
  })
  .join('');
const clNext = cl.slice(0, anchor) + sections + cl.slice(anchor);

// 3. src/lib/releaseNotes.ts — one entry per fragment that carries notes.
const rnPath = path.join(root, 'src', 'lib', 'releaseNotes.ts');
const withNotes = newestFirst.filter((entry) => entry.notes);
let rnNext = null;
if (withNotes.length) {
  const rn = readFileSync(rnPath, 'utf8');
  const rnAnchor = 'export const RELEASE_NOTES: ReleaseNote[] = [\n';
  const i = rn.indexOf(rnAnchor);
  if (i === -1) throw new Error('releaseNotes.ts anchor not found');
  const list = (arr) => arr.map((s) => `        ${JSON.stringify(s)},`).join('\n');
  const entries = withNotes
    .map((entry) => `  {
    version: '${entry.version}',
    date: '${entry.date || today}',${entry.time ? `\n    time: '${entry.time}',` : ''}${entry.commit ? `\n    commit: '${entry.commit}',` : ''}
    highlights: {
      en: [
${list(entry.notes.en)}
      ],
      tr: [
${list(entry.notes.tr)}
      ],
      de: [
${list(entry.notes.de)}
      ],
    },
  },
`)
    .join('');
  const at = i + rnAnchor.length;
  rnNext = rn.slice(0, at) + entries + rn.slice(at);
}

if (dryRun) {
  console.log(`--- dry run: ${timeline.length} fragment(s) -> ${version} ---\n`);
  console.log(sections);
  console.log(`release-notes entries: ${withNotes.length}`);
  process.exit(0);
}

writeFileSync(pkgPath, pkgNext);
writeFileSync(clPath, clNext);
if (rnNext) writeFileSync(rnPath, rnNext);

// 4. Consume the fragments.
for (const entry of timeline) unlinkSync(path.join(root, FRAGMENT_DIR, entry.file));

console.log(
  `compacted ${timeline.length} fragment(s) into ${timeline.length} release(s) -> ${version}` +
    ` (${withNotes.length} with user-facing notes)`
);
for (const entry of timeline) {
  console.log(`  ${entry.version}  ${entry.date || today} ${entry.time}  ${entry.commit || '-'}  ${entry.file}`);
}
