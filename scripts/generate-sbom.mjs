#!/usr/bin/env node
// CycloneDX SBOM for the production dependency tree (#2059).
//
// "Send us your SBOM" is a standard line in an enterprise or public-sector
// questionnaire. This produces one, stamps it with the version and commit the
// release system already resolves, and writes it to public/sbom.cdx.json so the
// deployed app serves it at /sbom.cdx.json — no login, no account, no email to
// a sales address. Procurement will not create an account to read a JSON file.
//
// WHY public/ AND NOT A ROUTE HANDLER: the file lands in the Docker build
// context before `docker build`, so `COPY . .` picks it up and Next serves it
// as a static asset. No route, no code, no cache invalidation logic, and — the
// part that matters — the SBOM inside an image always describes THAT image,
// because it was generated from the same lockfile that image installs from.
// src/middleware.ts already excludes any path containing a dot, so the file is
// reachable without touching the auth matcher.
//
// WHY --package-lock-only: build-image.yml deliberately never runs `npm ci` on
// the runner (the install happens inside the image), and this must not add one
// just to describe the tree. The lockfile is the more honest source anyway: it
// says what WILL be installed, rather than what happens to be on this machine.
//
// WHY npx AND NOT A devDependency: @cyclonedx/cyclonedx-npm is needed in two
// CI steps and nowhere else — not at runtime, not in the app, not in a test.
// Adding it to devDependencies would put its whole tree into every
// contributor's install and into the `npm audit` surface, to save one pinned
// npx invocation. The version below is pinned exactly, so the generator cannot
// change under us between builds.
//
//   node scripts/generate-sbom.mjs                      # -> public/sbom.cdx.json
//   node scripts/generate-sbom.mjs --require-stamps      # CI: refuse to write an unstamped SBOM
//   node scripts/generate-sbom.mjs --output path.json    # somewhere else
//
// Fails closed: an unreachable registry, a generator error, or an SBOM that
// comes back without components exits non-zero. An SBOM that silently ships as
// an empty component list is worse than no SBOM, because it looks like an
// answer.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { readProductionTree } from './npm-production-tree.mjs';

const require = createRequire(import.meta.url);
const { resolveRelease } = require('./release-derive.cjs');

/** Pinned exactly: the generator is part of the evidence, not a moving target. */
const CYCLONEDX_VERSION = '4.0.2';
const SPEC_VERSION = '1.6';
const REPO_URL = 'https://github.com/21072026/Internship';

const ROOT = process.cwd();
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const requireStamps = flag('require-stamps');
const outputPath = path.resolve(ROOT, option('output', path.join('public', 'sbom.cdx.json')));

function die(message, hint) {
  console.error(`SBOM generation FAILED:\n\n  - ${message}`);
  if (hint) console.error(`\n${hint}`);
  console.error('');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 1. What are we stamping it with?
// ---------------------------------------------------------------------------

const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

// The displayed version is base + pending release fragments (#1275/#1457), the
// same arithmetic next.config.js runs for the build. Reuse it rather than
// reading package.json's version, which is only the base and is therefore
// behind by however many changes are pending compaction. RELEASE_STAMPS is read
// from the environment by resolveRelease, which is how build-image.yml already
// carries the answer into a context without .git.
let version;
try {
  version = resolveRelease(ROOT, pkg.version, process.env).version;
} catch (error) {
  die(
    `could not derive the release version: ${error.message}`,
    'That is the same code path next.config.js uses at build time, so this is a\nbroken release fragment rather than an SBOM problem. Run\n`npm run check:release-fragments`.',
  );
}

/** The commit the SBOM describes. Explicit flag > CI env > local git. */
function resolveCommit() {
  const explicit = option('commit') || process.env.GIT_SHA || process.env.GITHUB_SHA;
  if (explicit && explicit !== 'dev') return explicit;
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  if (git.status === 0 && git.stdout.trim()) return git.stdout.trim();
  return null;
}

const commit = resolveCommit();
if (!commit && requireStamps) {
  die(
    'no commit could be resolved, and --require-stamps was given',
    'build-image.yml passes `--commit ${{ inputs.ref }}`. If that stopped arriving,\nthe SBOM would ship claiming to describe an unknown commit — which is exactly\nthe kind of quietly-wrong evidence this flag exists to prevent.',
  );
}

// ---------------------------------------------------------------------------
// 2. Generate.
// ---------------------------------------------------------------------------

const tmpDir = process.env.RUNNER_TEMP || os.tmpdir();
const tmpFile = path.join(tmpDir, `sbom-${process.pid}.cdx.json`);

const generatorArgs = [
  '--yes',
  `@cyclonedx/cyclonedx-npm@${CYCLONEDX_VERSION}`,
  '--package-lock-only',
  // Development dependencies are not shipped, so they are not part of the bill
  // of materials for the artefact. Same scope as the licence inventory, on
  // purpose: the two documents must describe the same tree.
  '--omit',
  'dev',
  '--mc-type',
  'application',
  '--spec-version',
  SPEC_VERSION,
  '--output-format',
  'JSON',
  '--output-file',
  tmpFile,
];

console.error(`Generating CycloneDX ${SPEC_VERSION} SBOM with @cyclonedx/cyclonedx-npm@${CYCLONEDX_VERSION}…`);
const run = spawnSync('npx', generatorArgs, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'inherit', 'pipe'] });

if (run.error) {
  die(
    `could not run the generator: ${run.error.message}`,
    'npx fetches @cyclonedx/cyclonedx-npm from the registry. An unreachable\nregistry must fail the build rather than skip the SBOM.',
  );
}
if (run.status !== 0) {
  die(
    `@cyclonedx/cyclonedx-npm exited ${run.status}`,
    `Its stderr:\n${(run.stderr || '(empty)').trim()}`,
  );
}
if (!existsSync(tmpFile)) {
  die(`the generator reported success but wrote no file to ${tmpFile}`);
}

let bom;
try {
  bom = JSON.parse(readFileSync(tmpFile, 'utf8'));
} catch (error) {
  die(`the generated SBOM is not valid JSON: ${error.message}`);
} finally {
  rmSync(tmpFile, { force: true });
}

if (bom.bomFormat !== 'CycloneDX') {
  die(`the generated document is not a CycloneDX BOM (bomFormat: ${JSON.stringify(bom.bomFormat)})`);
}
if (!Array.isArray(bom.components) || bom.components.length === 0) {
  die(
    'the generated SBOM has no components',
    'An SBOM with an empty component list is worse than no SBOM: it reads as an\nanswer. Check that package-lock.json is present and is lockfileVersion 3.',
  );
}

// ---------------------------------------------------------------------------
// 3. Prune it back to the tree it claims to describe.
// ---------------------------------------------------------------------------
//
// `--omit dev` is not sufficient on its own. It walks `npm ls --omit=dev`,
// which follows OPTIONAL PEER edges out of production packages and so drags in
// ten dev-only packages here — `prisma`, `@playwright/test`, `playwright-core`,
// `@prisma/engines` and friends, because `@prisma/client` declares
// `peerDependencies: { prisma: "*" }`. An SBOM headed "production dependencies"
// that lists the test runner is not a small cosmetic problem: it is the
// document a reviewer diffs against their own scan, and every wrong row costs
// somebody an afternoon.
//
// The lockfile's own `dev` flag does not have that blind spot, so the generated
// BOM is filtered against it — through the same module the licence inventory
// reads, so the two documents cannot describe different trees. Then it is
// checked in both directions and fails if anything is missing, because a
// silently under-reported SBOM is the failure mode that matters.

let tree;
try {
  tree = readProductionTree(ROOT);
} catch (error) {
  die(`could not read the production tree from package-lock.json: ${error.message}`);
}

const key = (component) => `${component.group ? `${component.group}/` : ''}${component.name}@${component.version}`;

const dropped = [];
// The root component stays whatever happens: it is this application, not a
// dependency, so it is not in the lockfile's package list.
const keptRefs = new Set([bom.metadata?.component?.['bom-ref']].filter(Boolean));

function pruneComponents(list) {
  if (!Array.isArray(list)) return list;
  const kept = [];
  for (const item of list) {
    if (!tree.keys.has(key(item))) {
      dropped.push(key(item));
      continue; // its nested children go with it: they are only reachable here
    }
    if (item['bom-ref']) keptRefs.add(item['bom-ref']);
    if (item.components) item.components = pruneComponents(item.components);
    kept.push(item);
  }
  return kept;
}

bom.components = pruneComponents(bom.components);

// The dependency graph is keyed by bom-ref, so a pruned component must take its
// node and every edge pointing at it with it — a dangling ref makes some
// consumers reject the document outright.
if (Array.isArray(bom.dependencies)) {
  bom.dependencies = bom.dependencies
    .filter((node) => keptRefs.has(node.ref))
    .map((node) => ({
      ...node,
      ...(Array.isArray(node.dependsOn)
        ? { dependsOn: node.dependsOn.filter((ref) => keptRefs.has(ref)) }
        : {}),
    }));
}

const present = new Set();
(function collect(list) {
  for (const item of list || []) {
    present.add(key(item));
    collect(item.components);
  }
})(bom.components);

const missing = [...tree.keys].filter((wanted) => !present.has(wanted));
if (missing.length) {
  die(
    `${missing.length} production package(s) are in package-lock.json but not in the generated SBOM: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ', …' : ''}`,
    'An SBOM that under-reports is the one dangerous kind. Either the generator\nchanged its output shape, or the pruning above is now wrong — do not ship the\ndocument until they agree.',
  );
}

if (dropped.length) {
  console.error(
    `Pruned ${dropped.length} component(s) that npm reported despite --omit dev ` +
      `(reachable only along a dev or optional-peer edge): ${[...new Set(dropped)].sort().join(', ')}.`,
  );
}

// ---------------------------------------------------------------------------
// 4. Stamp it.
// ---------------------------------------------------------------------------

bom.metadata = bom.metadata || {};
const component = (bom.metadata.component = bom.metadata.component || {});

// The generator picks up package.json's version, which is the BASE version —
// behind by every pending release fragment. Replace it with the version the app
// itself reports, so "which build is this?" has one answer across the footer,
// /api/health, the changelog and the SBOM.
component.version = version;
if (component.name) component.purl = `pkg:npm/${component.name}@${version}`;

// `bom-ref` is deliberately NOT rewritten. It is an opaque graph key, and this
// generator builds it hierarchically — every nested component's ref is
// "<root ref>|<parent>|<child>". Renaming the root's ref to carry the derived
// version would leave several hundred child refs prefixed with the old string
// and the dependency graph pointing at a node name that no longer exists. The
// fields a consumer reads for "which version is this" are `version` and `purl`,
// and both are stamped above.


// The sole rights holder is a natural person (Mehmet Erşahin) and no company
// holds the IP — see CLAUDE.md → Licensing & IP and
// docs/legal/licensing-strategy.md. Procurement tooling renders `supplier`, so
// it must not be filled with a company name.
if (pkg.author) {
  bom.metadata.supplier = { name: typeof pkg.author === 'string' ? pkg.author : pkg.author.name };
}

component.externalReferences = [
  ...(component.externalReferences || []).filter((ref) => ref.type !== 'vcs'),
  {
    type: 'vcs',
    url: commit ? `${REPO_URL}/tree/${commit}` : REPO_URL,
    comment: commit ? 'The exact commit this SBOM describes' : 'Commit unknown — locally generated SBOM',
  },
];

const stampedProperties = new Map([
  ['internship:release:version', version],
  ['internship:git:commit', commit || 'unknown'],
  [
    'internship:sbom:scope',
    'Production dependencies resolved from package-lock.json (npm --omit dev). Includes the platform-specific optional variants the lockfile permits (darwin/win32 binaries as well as the linux ones this image installs), so the list is a superset of one platform rather than an under-report.',
  ],
  ['internship:sbom:generator', `@cyclonedx/cyclonedx-npm@${CYCLONEDX_VERSION}`],
]);
if (process.env.GITHUB_RUN_ID) {
  stampedProperties.set(
    'internship:build:run',
    `${REPO_URL}/actions/runs/${process.env.GITHUB_RUN_ID}`,
  );
}
bom.metadata.properties = [
  ...(bom.metadata.properties || []).filter((property) => !stampedProperties.has(property.name)),
  ...[...stampedProperties].map(([name, value]) => ({ name, value })),
];

// ---------------------------------------------------------------------------
// 5. Write it.
// ---------------------------------------------------------------------------

mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(bom, null, 2)}\n`);

const relative = path.relative(ROOT, outputPath) || outputPath;
// `components` is a nested tree (the generator mirrors the install paths), so
// its top-level length is not the component count — it understates it by every
// transitively-installed package.
console.error(
  `SBOM written to ${relative} — ${present.size} production components, ` +
    `version ${version}, commit ${commit ? commit.slice(0, 7) : 'unknown'}, CycloneDX ${bom.specVersion}.`,
);
