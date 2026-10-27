#!/usr/bin/env node
// Third-party licence inventory and gate (#2059).
//
// Produces docs/legal/third-party-licenses.md and fails when a production
// dependency's licence is incompatible with distributing this codebase under
// AGPL-3.0-or-later, or with selling a commercial licence on top of it. The
// policy — which SPDX id means what, and why — lives in
// scripts/license-policy.mjs; this file is the plumbing.
//
// Why it exists: this project is dual-licensed with a single natural person as
// rights holder (docs/legal/licensing-strategy.md). The question "is there
// anything in your dependency tree that makes the commercial grant
// impossible?" is a standard one in an enterprise procurement pack, and before
// this it could only be answered by a manual audit. A copyleft dependency with
// a network clause, or a package that declares no licence at all, has to stop
// the build on the day it arrives — not on the day somebody reads the tree.
//
// SOURCE OF TRUTH: package-lock.json via scripts/npm-production-tree.mjs, which
// the SBOM generator also uses — so "these two documents describe the same
// tree" is true by construction rather than by two parsers agreeing. Runs with
// no install, no network and no new dependency. node_modules is consulted only
// as a fallback for a package whose lockfile entry has no licence field, and
// never as the primary answer.
//
// SCOPE: production dependencies (everything the lockfile does not mark `dev`,
// optional platform binaries included — those do get installed and shipped).
// Dev dependencies are counted but not gated: they are never distributed, so
// their licences create no obligation for either the AGPL distribution or the
// commercial grant. They are the only exclusion, and it is deliberate.
//
// DRIFT: the document embeds a signature over the policy-relevant facts
// (package name, declared licence, verdict) — NOT over version numbers. So a
// patch bump that changes nothing legally does not turn a Dependabot PR red,
// while a new dependency, a removed one, or a licence change does, which is
// exactly when a person needs to look.
//
//   npm run check:licenses            # evaluate; fail on a bad licence or drift
//   npm run check:licenses -- --write # regenerate the document
//
// Run with no install: `node scripts/check-licenses.mjs`.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { ALLOWLIST, VERDICTS, classify, verdict as verdictInfo } from './license-policy.mjs';
import { readProductionTree } from './npm-production-tree.mjs';

const ROOT = process.cwd();
const OUTPUT = path.join('docs', 'legal', 'third-party-licenses.md');
const SIGNATURE_MARKER = 'license-inventory-signature';
const write = process.argv.includes('--write');

function fail(problems, hint) {
  console.error('licence check FAILED:\n');
  for (const problem of problems) console.error(`  - ${problem}`);
  if (hint) console.error(`\n${hint}`);
  console.error('');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 1. Read the tree out of the lockfile.
// ---------------------------------------------------------------------------

let tree;
try {
  tree = readProductionTree(ROOT);
} catch (error) {
  fail(
    [error.message],
    'A gate that finds nothing to check must fail, not report a clean bill of health.',
  );
}

const { devCount } = tree;
const production = tree.packages.map((pkg) => ({
  ...pkg,
  ...classify(pkg),
}));

// Development dependencies are NOT gated — nothing imports them at runtime and
// no licence obligation attaches to code the application does not use. But the
// usual justification for skipping them ("they are never distributed") is not
// true of this project's container: the Dockerfile runs a full `npm ci` because
// `next build` needs typescript and tailwind, and the runner stage copies
// node_modules wholesale, so the dev tree is physically present in the image.
// So rather than assert the comfortable thing, evaluate them and report what
// comes back. If this number ever stops being zero, the exclusion stops being
// free and the right fix is `npm prune --omit=dev` in the runner stage.
const devBlocking = tree.devPackages
  .map((pkg) => ({ ...pkg, ...classify(pkg) }))
  .filter((pkg) => verdictInfo(pkg.verdict).blocks);

// One row per package name: the same package can appear at several paths (and
// occasionally at several versions). Merge them so the inventory reads as a
// list of packages rather than of installation paths.
const byName = new Map();
for (const pkg of production.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))) {
  const existing = byName.get(pkg.name);
  if (!existing) {
    byName.set(pkg.name, { ...pkg, versions: [pkg.version] });
  } else if (!existing.versions.includes(pkg.version)) {
    existing.versions.push(pkg.version);
  }
}
const packages = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));

// ---------------------------------------------------------------------------
// 2. Verdicts.
// ---------------------------------------------------------------------------

const blocking = packages.filter((pkg) => verdictInfo(pkg.verdict).blocks);

const byVerdict = new Map(VERDICTS.map((v) => [v.key, []]));
for (const pkg of packages) byVerdict.get(pkg.verdict).push(pkg);

const byLicense = new Map();
for (const pkg of packages) {
  const key = pkg.declared;
  if (!byLicense.has(key)) byLicense.set(key, { license: key, verdict: pkg.verdict, count: 0 });
  byLicense.get(key).count += 1;
}
const licenseRows = [...byLicense.values()].sort((a, b) => b.count - a.count || a.license.localeCompare(b.license));

/**
 * Signature over the facts a human would have to re-decide: which packages are
 * in the production tree, what they declare, and what we concluded. Versions
 * are excluded on purpose (see the header).
 */
const signature = createHash('sha256')
  .update(packages.map((pkg) => `${pkg.name}\t${pkg.declared}\t${pkg.verdict}`).join('\n'))
  .digest('hex')
  .slice(0, 16);

// An allowlist entry for a package that has left the tree is dead weight that
// will one day be read as a live decision. Reported, and it fails: unlike an
// npm advisory, the allowlist only changes when somebody edits this repo, so
// there is no risk of a red build appearing out of nowhere.
const presentNames = new Set(packages.map((pkg) => pkg.name));
const staleAllowlist = Object.keys(ALLOWLIST).filter((key) => !presentNames.has(key.split('@').slice(0, -1).join('@') || key));

// ---------------------------------------------------------------------------
// 3. Render the inventory.
// ---------------------------------------------------------------------------

const escape = (text) => String(text).replace(/\|/g, '\\|');

function render() {
  const lines = [];
  lines.push('# Third-party licence inventory');
  lines.push('');
  lines.push('<!-- GENERATED FILE — do not edit by hand.');
  lines.push('     Regenerate with: npm run check:licenses -- --write');
  lines.push(`     ${SIGNATURE_MARKER}: ${signature} -->`);
  lines.push('');
  lines.push('> Not legal advice. This is the machine-checked inventory a procurement');
  lines.push('> questionnaire asks for, and the input to a lawyer’s review — not a');
  lines.push('> substitute for one.');
  lines.push('');
  lines.push('This project is licensed **AGPL-3.0-or-later** and is **dual-licensed**: the');
  lines.push('sole rights holder — **Mehmet Erşahin**, a natural person — may also grant a');
  lines.push('commercial licence on terms that are not the AGPL');
  lines.push('([licensing-strategy.md](licensing-strategy.md)). That second possibility is');
  lines.push('what makes this inventory load-bearing rather than decorative: a dependency');
  lines.push('can be perfectly fine to *distribute* under the AGPL and still make the');
  lines.push('commercial grant impossible. Both questions are checked separately, per');
  lines.push('package, by `npm run check:licenses` on every pull request.');
  lines.push('');
  lines.push('**Scope**: the production dependency tree read from `package-lock.json`');
  lines.push(`— ${packages.length} packages over ${production.length} installation paths, the same set`);
  lines.push('described by that build’s CycloneDX SBOM at `/sbom.cdx.json` (both read this');
  lines.push('one source, so the two documents cannot disagree).');
  lines.push('');
  lines.push(`**Development dependencies** (${devCount} packages) are not listed here and do not`);
  lines.push('gate the build: nothing imports them at runtime, so no licence obligation');
  lines.push('attaches to them through this application. Worth stating plainly rather than');
  lines.push('waving through, though — the container image does physically contain them,');
  lines.push('because the Dockerfile runs a full `npm ci` (`next build` needs TypeScript and');
  lines.push('Tailwind) and copies `node_modules` wholesale. They are therefore evaluated');
  lines.push(
    `against the same policy anyway, and **${devBlocking.length === 0 ? 'none of them carries a blocking licence' : `${devBlocking.length} of them carries a blocking licence`}** as of this`,
  );
  lines.push('generation — so the exclusion changes no answer today.');
  if (devBlocking.length) {
    lines.push('');
    for (const pkg of devBlocking) {
      lines.push(`- \`${escape(pkg.name)}@${escape(pkg.version)}\` — \`${escape(pkg.declared)}\`: ${verdictInfo(pkg.verdict).label}`);
    }
  }
  lines.push('');
  lines.push('## Verdict summary');
  lines.push('');
  lines.push('| Verdict | Packages | What it means |');
  lines.push('|---|---:|---|');
  for (const tier of VERDICTS) {
    const rows = byVerdict.get(tier.key);
    if (!rows.length) continue;
    lines.push(`| ${tier.label} | ${rows.length} | ${escape(tier.summary)} |`);
  }
  lines.push('');
  if (blocking.length === 0) {
    lines.push('**No blocking licence in the production tree.** Nothing here prevents');
    lines.push('distribution under AGPL-3.0-or-later, and nothing here prevents a commercial');
    lines.push('licence being granted on top of it.');
  } else {
    lines.push(`**${blocking.length} blocking licence(s).** See the flagged rows below; the`);
    lines.push('check fails until each is removed, replaced, or resolved with a written');
    lines.push('reason in `scripts/license-policy.mjs`.');
  }
  lines.push('');
  lines.push('## By licence');
  lines.push('');
  lines.push('| Declared licence | Packages | Verdict |');
  lines.push('|---|---:|---|');
  for (const row of licenseRows) {
    lines.push(`| \`${escape(row.license)}\` | ${row.count} | ${verdictInfo(row.verdict).label} |`);
  }
  lines.push('');

  const allowlisted = byVerdict.get('allowlisted');
  lines.push('## Hand-resolved packages');
  lines.push('');
  if (!allowlisted.length) {
    lines.push('None. Every package in the tree declares a licence that resolves on its own.');
  } else {
    lines.push('A package whose declared string is not a resolvable SPDX expression is');
    lines.push('resolved by reading the licence text shipped inside it. Each one carries its');
    lines.push('reason, in prose, in `scripts/license-policy.mjs` — the same discipline as');
    lines.push('[`docs/security-exceptions.md`](../security-exceptions.md): the reason *is*');
    lines.push('the entry, so an allowlisting nobody could justify in a sentence never gets');
    lines.push('written.');
    lines.push('');
    for (const pkg of allowlisted) {
      lines.push(`### \`${pkg.name}\` — declares \`${escape(pkg.declared)}\`, resolved as \`${escape(pkg.spdx)}\``);
      lines.push('');
      lines.push(pkg.reason);
      lines.push('');
    }
  }
  lines.push('## Full inventory');
  lines.push('');
  lines.push('| Package | Version | Declared licence | Verdict |');
  lines.push('|---|---|---|---|');
  for (const pkg of packages) {
    lines.push(
      `| \`${escape(pkg.name)}\` | ${escape(pkg.versions.join(', '))} | \`${escape(pkg.declared)}\` | ${verdictInfo(pkg.verdict).label} |`,
    );
  }
  lines.push('');
  lines.push('## How this file is produced and kept honest');
  lines.push('');
  lines.push('- `scripts/check-licenses.mjs` reads `package-lock.json` — no install, no');
  lines.push('  network, no extra dependency — and classifies each declared licence through');
  lines.push('  the policy table in `scripts/license-policy.mjs`.');
  lines.push('- An SPDX id nobody has classified resolves to **unknown**, which fails. The');
  lines.push('  default is deliberately "stop and ask a human", not "probably fine".');
  lines.push('- `OR` expressions take the most permissive branch (the recipient chooses, so');
  lines.push('  we choose); `AND` expressions take the most restrictive (every term binds).');
  lines.push('- The signature in the comment at the top covers **package names, declared');
  lines.push('  licences and verdicts** — not version numbers. A patch bump that changes');
  lines.push('  nothing legally will not fail CI; a new dependency, a removed one, or a');
  lines.push('  changed licence will. Regenerate with `npm run check:licenses -- --write`.');
  lines.push('- Related: [`docs/trust/vulnerability-management.md`](../trust/vulnerability-management.md)');
  lines.push('  (the security side of the same supply chain) and');
  lines.push('  [`docs/legal/licensing-strategy.md`](licensing-strategy.md) (why dual');
  lines.push('  licensing, and what it requires of us).');
  lines.push('');
  return `${lines.join('\n')}`;
}

const rendered = render();

// ---------------------------------------------------------------------------
// 4. Verdict.
// ---------------------------------------------------------------------------

const problems = [];

for (const pkg of blocking) {
  const info = verdictInfo(pkg.verdict);
  problems.push(
    `\`${pkg.name}@${pkg.versions.join(', ')}\` declares \`${pkg.declared}\` — ${info.label}. ${info.summary}`,
  );
}

for (const key of staleAllowlist) {
  problems.push(
    `scripts/license-policy.mjs allowlists \`${key}\`, which is no longer in the production tree — remove the entry so it is not read later as a live decision`,
  );
}

if (write) {
  writeFileSync(path.join(ROOT, OUTPUT), rendered);
  console.log(`licence inventory written to ${OUTPUT} (${packages.length} production packages, signature ${signature})`);
} else {
  const outputPath = path.join(ROOT, OUTPUT);
  if (!existsSync(outputPath)) {
    problems.push(`${OUTPUT} does not exist — run \`npm run check:licenses -- --write\` and commit it`);
  } else {
    const committed = readFileSync(outputPath, 'utf8');
    const found = new RegExp(`${SIGNATURE_MARKER}: ([0-9a-f]+)`).exec(committed);
    if (!found) {
      problems.push(
        `${OUTPUT} has no ${SIGNATURE_MARKER} comment — it was hand-edited or written by an older version of this script; regenerate it with \`npm run check:licenses -- --write\``,
      );
    } else if (found[1] !== signature) {
      problems.push(
        `${OUTPUT} is out of date: it was generated for signature ${found[1]}, the tree is now ${signature}. A package was added, removed, or changed its licence. Run \`npm run check:licenses -- --write\`, read the diff, and commit it.`,
      );
    }
  }
}

if (problems.length) {
  fail(
    problems,
    'The policy — which licences are acceptable and why — is in scripts/license-policy.mjs.\n' +
      'Resolving a package by hand means adding an ALLOWLIST entry there WITH a written\n' +
      'reason; the reason is rendered into the inventory, so it has to be one you would\n' +
      'be happy for a buyer to read.',
  );
}

const tally = VERDICTS.filter((tier) => byVerdict.get(tier.key).length)
  .map((tier) => `${tier.label}=${byVerdict.get(tier.key).length}`)
  .join(' · ');
console.log(
  `licence check OK — ${packages.length} production packages, 0 blocking [${tally}]; ` +
    `${devCount} dev packages not gated (${devBlocking.length} of them blocking if they ever were)`,
);
