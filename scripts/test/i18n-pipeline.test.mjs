// The translator pipeline (#2082): export → import round trip and the import's
// refusals. Run: npm run test:i18n-pipeline (also part of test:unit).
//
// The round trip runs against the REAL dictionary, so a dictionary construct the
// reader cannot see (a computed value, a spread) shows up here as a skipped path
// rather than as a string a translator silently never receives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { DICT_PATH, ImportRefused, applyImport, buildExport, quoteLiteral, readDictionary } from '../i18n-dict-lib.mjs';

const REAL = readFileSync(DICT_PATH, 'utf8');

const SAMPLE = `const en = {
  nav: {
    // Shown in the sidebar.
    home: 'Home',
    hello: 'Hello {name}',
    'dotted.key': "It's here",
  },
  days: ['Mon', 'Tue'],
};
type Dict = typeof en;
const de: Dict = {
  nav: {
    home: 'Start',
    hello: 'Hallo {name}',
    'dotted.key': 'Hier',
  },
  days: ['Mo', 'Di'],
};
`;

test('every string of the real dictionary is exported, and nothing is skipped', () => {
  const all = readDictionary(REAL);
  const en = all.get('en');
  assert.ok(en && en.entries.size > 1000, 'the English block was not found');
  for (const [locale, { entries, skipped }] of all) {
    assert.deepEqual(skipped, [], `${locale}: paths the pipeline cannot export: ${skipped.slice(0, 5).join(', ')}`);
    assert.equal(entries.size, en.entries.size, `${locale}: ${entries.size} strings vs en ${en.entries.size}`);
  }
});

test('export → import with no edits is a byte-identical no-op, for every locale', () => {
  for (const locale of readDictionary(REAL).keys()) {
    if (locale === 'en') continue;
    const doc = JSON.parse(JSON.stringify(buildExport(REAL, locale)));
    assert.equal(doc.meta.missing, 0);
    const res = applyImport(REAL, doc);
    assert.deepEqual(res.changed, []);
    assert.equal(res.text, REAL, `${locale}: the no-op import changed the file`);
  }
});

test('an edited string is written in place, escaped, and nothing else moves', () => {
  const doc = buildExport(SAMPLE, 'de');
  assert.equal(doc.strings['nav.home'].note, 'Shown in the sidebar.');
  assert.ok('nav["dotted.key"]' in doc.strings);
  doc.strings['nav.home'].target = "Startseite 'neu'\nzwei";
  doc.strings['nav["dotted.key"]'].target = 'Da "drin"';
  doc.strings['days.1'].target = 'Die';
  const res = applyImport(SAMPLE, doc);
  assert.deepEqual(res.changed.sort(), ['days.1', 'nav.home', 'nav["dotted.key"]'].sort());
  const back = readDictionary(res.text).get('de');
  assert.equal(back.entries.get('nav.home').value, "Startseite 'neu'\nzwei");
  assert.equal(back.entries.get('nav["dotted.key"]').value, 'Da "drin"');
  assert.equal(back.entries.get('days.1').value, 'Die');
  // Only the three literals differ: the rest of the file is the same lines.
  const before = SAMPLE.split('\n');
  const after = res.text.split('\n');
  assert.equal(after.length, before.length);
  assert.equal(after.filter((l, i) => l !== before[i]).length, 3);
  // And the result still parses as TypeScript.
  const sf = ts.createSourceFile('x.ts', res.text, ts.ScriptTarget.Latest, true);
  assert.equal(sf.parseDiagnostics.length, 0);
});

test('a file that would drop a key, or invents one, is refused whole', () => {
  const dropped = buildExport(SAMPLE, 'de');
  delete dropped.strings['nav.hello'];
  dropped.strings['nav.home'].target = 'Changed';
  assert.throws(() => applyImport(SAMPLE, dropped), (e) => e instanceof ImportRefused && /nav\.hello: missing from the file/.test(e.message));

  const invented = buildExport(SAMPLE, 'de');
  invented.strings['nav.extra'] = { source: 'x', target: 'y' };
  assert.throws(() => applyImport(SAMPLE, invented), /nav\.extra: not a key/);
});

test('MISSING, unreviewed machine translation and drifted placeholders are refused', () => {
  const missing = buildExport(SAMPLE, 'de');
  missing.strings['nav.home'] = { source: 'Home', target: null, status: 'MISSING' };
  assert.throws(() => applyImport(SAMPLE, missing), /nav\.home: still MISSING/);

  const mt = buildExport(SAMPLE, 'de');
  mt.strings['nav.home'] = { source: 'Home', target: 'Heim', status: 'MT' };
  assert.throws(() => applyImport(SAMPLE, mt), /not reviewed/);

  const drift = buildExport(SAMPLE, 'de');
  drift.strings['nav.hello'].target = 'Hallo {nom}';
  assert.throws(() => applyImport(SAMPLE, drift), /placeholders \{nom\} do not match the source's \{name\}/);
});

test('a locale with no block is exported as all MISSING and cannot be imported yet', () => {
  const fr = buildExport(SAMPLE, 'fr');
  assert.equal(fr.meta.missing, fr.meta.strings);
  assert.ok(Object.values(fr.strings).every((r) => r.status === 'MISSING' && r.target === null));
  assert.throws(() => applyImport(SAMPLE, fr), /has no block in the dictionary yet/);
});

test('a stale English source is a warning, not a refusal', () => {
  const doc = buildExport(SAMPLE, 'de');
  doc.strings['nav.home'].source = 'Homepage';
  doc.strings['nav.home'].target = 'Startseite';
  const res = applyImport(SAMPLE, doc);
  assert.deepEqual(res.changed, ['nav.home']);
  assert.match(res.warnings[0], /English source changed/);
});

test('quoteLiteral keeps the quote style and round-trips through the parser', () => {
  for (const [v, q] of [["it's", "'"], ['say "hi"', '"'], ['back\\slash\ttab', "'"], ['line sep', "'"]]) {
    const lit = quoteLiteral(v, q);
    assert.equal(lit[0], q);
    const sf = ts.createSourceFile('x.ts', `const x = ${lit};`, ts.ScriptTarget.Latest, true);
    const init = sf.statements[0].declarationList.declarations[0].initializer;
    assert.equal(init.text, v);
  }
});

const SAMPLE_WITH_MAP = `${SAMPLE}
export const dictionaries: Record<Locale, Dict> = { en, de };
`;

test('--create builds a new locale block from a complete file, in the English shape', async () => {
  const { addLocaleToConfig } = await import('../i18n-dict-lib.mjs');
  const doc = buildExport(SAMPLE_WITH_MAP, 'fr');
  for (const row of Object.values(doc.strings)) {
    row.target = `fr:${row.source}`;
    delete row.status;
  }
  // Without --create it is still refused.
  assert.throws(() => applyImport(SAMPLE_WITH_MAP, doc), /--create/);
  const res = applyImport(SAMPLE_WITH_MAP, doc, { create: true });
  assert.equal(res.created, 'fr');
  assert.match(res.text, /export const dictionaries: Record<Locale, Dict> = \{ en, de, fr \};/);
  const all = readDictionary(res.text);
  assert.deepEqual([...all.get('fr').entries.keys()], [...all.get('en').entries.keys()]);
  assert.equal(all.get('fr').entries.get('nav.hello').value, 'fr:Hello {name}');
  assert.equal(all.get('fr').entries.get('nav["dotted.key"]').value, "fr:It's here");
  // The blocks before it are untouched.
  assert.ok(res.text.startsWith(SAMPLE));
  const sf = ts.createSourceFile('x.ts', res.text, ts.ScriptTarget.Latest, true);
  assert.equal(sf.parseDiagnostics.length, 0);

  const config = "export const locales = ['en', 'tr', 'de'] as const;\nexport type Locale = (typeof locales)[number];\n";
  const next = addLocaleToConfig(config, 'fr');
  assert.match(next, /export const locales = \['en', 'tr', 'de', 'fr'\] as const;/);
  assert.equal(addLocaleToConfig(next, 'fr'), next, 'adding twice is a no-op');
});

test('--create refuses an incomplete, unreviewed or malformed new locale', () => {
  const partial = buildExport(SAMPLE_WITH_MAP, 'fr');
  partial.strings['nav.home'] = { source: 'Home', target: 'Accueil' };
  assert.throws(() => applyImport(SAMPLE_WITH_MAP, partial, { create: true }), /still MISSING/);

  const mt = buildExport(SAMPLE_WITH_MAP, 'fr');
  for (const row of Object.values(mt.strings)) Object.assign(row, { target: row.source, status: 'MT' });
  assert.throws(() => applyImport(SAMPLE_WITH_MAP, mt, { create: true }), /not reviewed/);

  const bad = buildExport(SAMPLE_WITH_MAP, 'FR-x');
  for (const row of Object.values(bad.strings)) Object.assign(row, { target: row.source, status: undefined });
  assert.throws(() => applyImport(SAMPLE_WITH_MAP, bad, { create: true }), /two-letter/);
});

test('check:locale-list counts hand-written lists, not quotations of them', async () => {
  const { countLocaleLists } = await import('../check-locale-list.mjs');
  assert.equal(countLocaleLists("const L = ['en', 'tr', 'de'] as const;"), 1);
  assert.equal(countLocaleLists('type X = "en" | "tr" | "de";'), 1);
  assert.equal(countLocaleLists("z.enum(['en','tr','de',])"), 1);
  assert.equal(countLocaleLists("// the codes are 'en' | 'tr' | 'de'\n/* ['en', 'tr', 'de'] */"), 0);
  assert.equal(countLocaleLists("z.enum(locales)"), 0);
  assert.equal(countLocaleLists("const url = 'https://x.example'; const l = ['en', 'tr', 'de'];"), 1);
});
