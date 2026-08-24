// Shared release-fragment logic (#1275). Used from three places, so it lives
// in one file with no dependencies:
//   - next.config.js       -> derive the build's version + unreleased notes
//   - scripts/release-compact.mjs -> fold fragments into the canonical files
//   - e2e/version-release-notes.spec.ts -> compute the expected footer version
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

const { readFileSync, readdirSync, existsSync } = require('node:fs');
const path = require('node:path');

const FRAGMENT_DIR = path.join('releases', 'unreleased');
const LOCALES = ['en', 'tr', 'de'];

/** All fragments, sorted by filename for a deterministic version. */
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

/**
 * Apply fragments to a base semver (suffix like "-beta" is preserved):
 * each minor fragment bumps the minor and resets patch; each patch fragment
 * bumps the patch. Deterministic: fragments are pre-sorted by filename.
 */
function deriveVersion(baseVersion, fragments) {
  const m = baseVersion.match(/^(\d+)\.(\d+)\.(\d+)(-.*)?$/);
  if (!m) throw new Error(`unparseable base version: ${baseVersion}`);
  let [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const suffix = m[4] ?? '';
  for (const fragment of fragments) {
    if (fragment.bump === 'minor') {
      minor += 1;
      patch = 0;
    } else {
      patch += 1;
    }
  }
  return `${major}.${minor}.${patch}${suffix}`;
}

/**
 * The user-facing notes of all fragments that carry any, merged in fragment
 * order — the shape of one RELEASE_NOTES highlights entry, or null when no
 * fragment has notes.
 */
function unreleasedHighlights(fragments) {
  const withNotes = fragments.filter((f) => f.notes);
  if (withNotes.length === 0) return null;
  const highlights = { en: [], tr: [], de: [] };
  for (const fragment of withNotes) {
    for (const locale of LOCALES) highlights[locale].push(...fragment.notes[locale]);
  }
  return highlights;
}

module.exports = { FRAGMENT_DIR, LOCALES, readFragments, validateFragment, deriveVersion, unreleasedHighlights };
