#!/usr/bin/env node
// Export the dictionary for a translator (#2082, docs/i18n.md).
//
//   npm run i18n:export                     every locale except the source → i18n/exports/<locale>.json
//   npm run i18n:export -- --locale de      one locale
//   npm run i18n:export -- --locale fr      a locale with no block yet: every target MISSING
//   options: --source en  --out <dir>  --dict <path>
//
// One flat JSON file per locale: "dotted.key": { source, target, note? }, in
// dictionary order, with the English source beside every target and
// "status": "MISSING" where there is none. Read-only on the dictionary.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DICT_PATH, buildExport, readDictionary } from './i18n-dict-lib.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const dict = opt('dict', DICT_PATH);
const out = opt('out', 'i18n/exports');
const source = opt('source', 'en');
const text = readFileSync(dict, 'utf8');
const one = opt('locale', null);
const locales = one ? [one] : [...readDictionary(text).keys()].filter((l) => l !== source);

mkdirSync(out, { recursive: true });
for (const locale of locales) {
  const doc = buildExport(text, locale, source);
  const file = join(out, `${locale}.json`);
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`i18n:export ${file} — ${doc.meta.strings} string(s), ${doc.meta.missing} MISSING`);
}
