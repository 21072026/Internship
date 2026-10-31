#!/usr/bin/env node
// Merge a translator's file back into the dictionary (#2082, docs/i18n.md).
//
//   npm run i18n:import -- i18n/exports/de.json            write src/i18n/dictionaries.ts in place
//   npm run i18n:import -- i18n/exports/de.json --check    report only, write nothing
//   npm run i18n:import -- i18n/exports/fr.json --create   a NEW locale: add its block and list it in src/i18n/config.ts
//   options: --dict <path>  --config <path>
//
// Only the literals whose value changed are rewritten; formatting, comments and
// key order stay. Refuses — and writes nothing — when the file would drop a
// key, names an unknown one, still has MISSING or unreviewed MT strings, or
// changes a string's {placeholders}.
import { readFileSync, writeFileSync } from 'node:fs';
import { DICT_PATH, ImportRefused, addLocaleToConfig, applyImport } from './i18n-dict-lib.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const file = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--dict' && args[i - 1] !== '--config');
if (!file) {
  console.error('usage: npm run i18n:import -- <export.json> [--check] [--dict <path>]');
  process.exit(2);
}
const dict = opt('dict', DICT_PATH);
const config = opt('config', 'src/i18n/config.ts');
const check = args.includes('--check');
try {
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  const res = applyImport(readFileSync(dict, 'utf8'), doc, { create: args.includes('--create') });
  for (const w of res.warnings) console.warn(`warning: ${w}`);
  if (!check && res.changed.length) writeFileSync(dict, res.text);
  if (!check && res.created) writeFileSync(config, addLocaleToConfig(readFileSync(config, 'utf8'), res.created));
  const verb = check ? 'would change' : 'changed';
  console.log(
    res.created
      ? `i18n:import ${res.created}: new locale block with ${res.changed.length} string(s) ${check ? 'would be added' : `added, and listed in ${config}`}.`
      : `i18n:import ${doc.meta.locale}: ${res.changed.length} string(s) ${verb}${res.warnings.length ? `, ${res.warnings.length} warning(s)` : ''}.`,
  );
  if (res.created && !check) console.log('Next: npx tsc --noEmit lists every Record<Locale, …> that needs the new language (docs/i18n.md § Adding a locale).');
  else if (res.changed.length && !check) console.log('Next: npm run check:i18n && npx tsc --noEmit');
} catch (e) {
  console.error(e instanceof ImportRefused ? e.message : `i18n:import failed: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
