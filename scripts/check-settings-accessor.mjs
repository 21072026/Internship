#!/usr/bin/env node
// Guard: settings are read through ONE accessor (#1621).
//
// WHY THIS EXISTS
//   The settings chain — programme row → org row → global row → code default —
//   is written once, in `pickSetting()` (src/lib/settings.ts), and read through
//   `resolveSetting()` / `resolveSettingRaw()` / `resolveSettings()` in
//   src/lib/settingsResolver.ts, which add the per-request cache and the
//   programme scope (#1619). A route that reaches for `prisma.setting` itself
//   compiles and passes its own test while reading the global row for every
//   tenant — the exact bug #2628 fixed by hand in a dozen places. A new caller
//   of the legacy string readers (`getSetting()` / `getSettings()`) silently
//   loses the programme layer and the cache. Nothing else would notice.
//
// WHAT IT CHECKS (every tracked .ts/.tsx under src/)
//   1. Model access — `prisma.setting.…` / `tx.setting.…` — only in the
//      settings modules themselves, or in a file listed in ALLOWED_MODEL_ACCESS
//      with its reason.
//   2. An import of `getSetting` / `getSettings` — only in the files listed in
//      PENDING_LEGACY_READERS. That list is a RATCHET: its length is pinned by
//      EXPECTED_PENDING, so adding a name means moving the number in the same
//      diff (a reviewed decision), and moving a reader onto the accessor means
//      deleting its entry (a stale entry fails too).
//   Neither list can rot: an entry whose file no longer does the thing fails,
//   asking for the line to be deleted.
//
// Run: npm run check:settings-accessor
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const SETTINGS_MODULES = new Set(['src/lib/settings.ts', 'src/lib/settingsResolver.ts']);

const ALLOWED_MODEL_ACCESS = new Map([
  [
    'src/lib/jobs/reportSubscriptions.ts',
    'the legacy weekly-report seed claims an org with a marker row (LEGACY_SEED_KEY, not a catalogued setting) inside a Serializable transaction (#3078) — a claim, not a setting read, and setSetting() offers no claim',
  ],
]);

// Legacy string readers still waiting for the accessor. Each needs a reason.
const PENDING_LEGACY_READERS = new Map([
  [
    'src/lib/retention.ts',
    'client-reachable (DocumentsManager → documentAccess → retention): settingsResolver imports node:async_hooks, which webpack refuses in a client graph — needs the server half split out first',
  ],
]);
const EXPECTED_PENDING = 1;

const MODEL_ACCESS = /\b(?:prisma|tx|db|client)\.setting\.[a-zA-Z]+\(/;
const LEGACY_IMPORT = /import\s*\{[^}]*\bgetSettings?\b[^}]*\}\s*from\s*['"](?:@\/lib\/settings|\.{1,2}\/(?:[\w./]*\/)?settings)['"]/s;

const files = execFileSync('git', ['ls-files', 'src'], { encoding: 'utf8' })
  .split('\n')
  .filter((f) => /\.(?:ts|tsx)$/.test(f));

const problems = [];
const seenModel = new Set();
const seenLegacy = new Set();

for (const file of files) {
  if (SETTINGS_MODULES.has(file)) continue;
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue; // deleted in the working tree but still in the index
  }
  const code = text.replace(/^\s*\/\/.*$/gm, '');
  if (MODEL_ACCESS.test(code)) {
    seenModel.add(file);
    if (!ALLOWED_MODEL_ACCESS.has(file)) {
      code.split('\n').forEach((line, i) => {
        if (MODEL_ACCESS.test(line)) problems.push(`direct Setting access: ${file}:${i + 1}`);
      });
    }
  }
  if (LEGACY_IMPORT.test(code)) {
    seenLegacy.add(file);
    if (!PENDING_LEGACY_READERS.has(file)) problems.push(`new legacy reader (getSetting/getSettings import): ${file}`);
  }
}

for (const file of ALLOWED_MODEL_ACCESS.keys()) {
  if (!seenModel.has(file)) problems.push(`stale ALLOWED_MODEL_ACCESS entry (no direct Setting access any more) — delete it: ${file}`);
}
for (const file of PENDING_LEGACY_READERS.keys()) {
  if (!seenLegacy.has(file)) problems.push(`stale PENDING_LEGACY_READERS entry (moved onto the accessor) — delete it and lower EXPECTED_PENDING: ${file}`);
}
if (PENDING_LEGACY_READERS.size !== EXPECTED_PENDING) {
  problems.push(`PENDING_LEGACY_READERS has ${PENDING_LEGACY_READERS.size} entries but EXPECTED_PENDING is ${EXPECTED_PENDING} — move both in the same diff`);
}

if (problems.length) {
  console.error('Settings must be read through src/lib/settingsResolver.ts (#1621):');
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    '\nRead with resolveSetting(key, { orgId, programId }) — or resolveSettingRaw() when a rule module parses the string — and write with setSetting(). See docs/tenant-isolation.md § The programme layer and the typed accessor.',
  );
  process.exit(1);
}

console.log(
  `settings accessor OK — ${files.length} file(s) scanned; ${ALLOWED_MODEL_ACCESS.size} allowed direct access, ${PENDING_LEGACY_READERS.size} legacy reader(s) pending (pinned).`,
);
