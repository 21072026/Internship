// Fold the pending release fragments into the three canonical files (#1275):
//   package.json          -> version = base + fragments
//   CHANGELOG.md          -> one new section from the fragments' changelog text
//   src/lib/releaseNotes.ts -> one new entry from the fragments' notes (if any)
// then delete the fragments. Run by .github/workflows/release-compact.yml on a
// schedule (the result goes through a NORMAL pull request — branch protection
// stays intact), or by hand:  node scripts/release-compact.mjs
//
// Idempotent by construction: no fragments -> exit 0 without touching anything.
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { FRAGMENT_DIR, readFragments, validateFragment, deriveVersion, unreleasedHighlights } = require('./release-derive.cjs');

const root = process.cwd();
const fragments = readFragments(root);
if (fragments.length === 0) {
  console.log('no pending fragments — nothing to compact');
  process.exit(0);
}
fragments.forEach(validateFragment);

const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const version = deriveVersion(pkg.version, fragments);
const date = new Date().toISOString().slice(0, 10);

// 1. package.json — replace exactly the version line, preserving formatting.
const pkgRaw = readFileSync(pkgPath, 'utf8');
const pkgNext = pkgRaw.replace(`"version": "${pkg.version}"`, `"version": "${version}"`);
if (pkgNext === pkgRaw) throw new Error(`could not find "version": "${pkg.version}" in package.json`);
writeFileSync(pkgPath, pkgNext);

// 2. CHANGELOG.md — one section, fragment bullets in filename order.
const clPath = path.join(root, 'CHANGELOG.md');
const cl = readFileSync(clPath, 'utf8');
const anchor = cl.indexOf('## [');
if (anchor === -1) throw new Error('CHANGELOG.md has no "## [" section to anchor on');
const bullets = fragments.map((f) => f.changelog.trim()).join('\n');
const section = `## [${version}] - ${date}\n\n${bullets}\n\n`;
writeFileSync(clPath, cl.slice(0, anchor) + section + cl.slice(anchor));

// 3. src/lib/releaseNotes.ts — one entry when any fragment carries notes.
const highlights = unreleasedHighlights(fragments);
if (highlights) {
  const rnPath = path.join(root, 'src', 'lib', 'releaseNotes.ts');
  const rn = readFileSync(rnPath, 'utf8');
  const rnAnchor = 'export const RELEASE_NOTES: ReleaseNote[] = [\n';
  const i = rn.indexOf(rnAnchor);
  if (i === -1) throw new Error('releaseNotes.ts anchor not found');
  const list = (arr) => arr.map((s) => `        ${JSON.stringify(s)},`).join('\n');
  const entry = `  {
    version: '${version}',
    date: '${date}',
    highlights: {
      en: [
${list(highlights.en)}
      ],
      tr: [
${list(highlights.tr)}
      ],
      de: [
${list(highlights.de)}
      ],
    },
  },
`;
  const at = i + rnAnchor.length;
  writeFileSync(rnPath, rn.slice(0, at) + entry + rn.slice(at));
}

// 4. Consume the fragments.
for (const f of fragments) unlinkSync(path.join(root, FRAGMENT_DIR, f.file));

console.log(`compacted ${fragments.length} fragment(s) -> ${version} (${date})${highlights ? ' with release notes' : ''}`);
