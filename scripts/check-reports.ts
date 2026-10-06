// CI guard for the report registry (#1903). Every way of breaking a report
// definition is invisible to TypeScript: the label keys are plain strings, a
// definition without a loader type-checks, and a privacy-floor report whose
// size column is not a `number` column would silently never suppress anything.
//   node --experimental-strip-types scripts/check-reports.ts
import { readFileSync } from 'node:fs';
import { dictionaries } from '../src/i18n/dictionaries.ts';
import { DEFAULT_MIN_COHORT, REPORT_DEFINITIONS } from '../src/lib/reports/definitions.ts';

type AnyRec = Record<string, unknown>;

const errors: string[] = [];

function lookup(dict: AnyRec, path: string): unknown {
  return path.split('.').reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as AnyRec)[part] : undefined), dict);
}

// The loaders live in a server module (Prisma), which this script cannot
// import — so the loader map is read as text. A definition whose key has no
// `async '<key>'(` entry there would 404 on every request.
const registrySource = readFileSync(new URL('../src/lib/reports/registry.ts', import.meta.url), 'utf8');

const seen = new Set<string>();
for (const def of REPORT_DEFINITIONS) {
  if (seen.has(def.key)) errors.push(`[dup] report key "${def.key}" is defined twice`);
  seen.add(def.key);
  if (!/^[a-z][a-z0-9-]*$/.test(def.key)) errors.push(`[key] "${def.key}" is not kebab-case — it is a URL segment`);
  if (!registrySource.includes(`async '${def.key}'(`)) errors.push(`[loader] "${def.key}" has no loader in src/lib/reports/registry.ts`);

  const labelKeys = [def.titleKey, def.descriptionKey, ...def.columns.map((c) => c.labelKey)];
  for (const [loc, dict] of Object.entries(dictionaries)) {
    const reports = (dict as AnyRec).reports as AnyRec | undefined;
    for (const key of labelKeys) {
      const v = reports ? lookup(reports, key) : undefined;
      if (typeof v !== 'string' || !v.trim()) errors.push(`[label ${loc}] "${def.key}": reports.${key} is missing or empty`);
    }
  }

  const colKeys = new Set(def.columns.map((c) => c.key));
  if (colKeys.size !== def.columns.length) errors.push(`[columns] "${def.key}" repeats a column key`);
  if (def.aggregate) {
    const size = def.columns.find((c) => c.key === def.sizeColumn);
    const label = def.columns.find((c) => c.key === def.labelColumn);
    if (!size || size.type !== 'number') errors.push(`[floor] "${def.key}": sizeColumn must name a \`number\` column`);
    if (!label || label.type !== 'string') errors.push(`[floor] "${def.key}": labelColumn must name a \`string\` column`);
    // The floor may be raised per report, never lowered (docs/analytics.md).
    if (def.minCohort !== undefined && def.minCohort < DEFAULT_MIN_COHORT) {
      errors.push(`[floor] "${def.key}": minCohort ${def.minCohort} is below the default ${DEFAULT_MIN_COHORT}`);
    }
  }
}

if (errors.length) {
  console.error(`report registry check FAILED — ${errors.length} issue(s):`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}
console.log(`report registry OK — ${REPORT_DEFINITIONS.length} report(s), labels present in ${Object.keys(dictionaries).join('/')}`);
