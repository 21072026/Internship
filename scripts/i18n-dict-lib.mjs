// The translator pipeline's one reader and one writer of src/i18n/dictionaries.ts
// (#2082). Shared by scripts/i18n-export.mjs, scripts/i18n-import.mjs and their
// unit test, so the export and the import cannot disagree about what a key is.
//
// The dictionary stays a single typed TypeScript module — that is what gives
// compile-time key safety — so this file never evaluates it. It parses it with
// the TypeScript compiler, walks the `const <locale> = { … }` object literals,
// and treats every string literal leaf as one translatable entry addressed by
// its dotted path (array items by index; a key that itself contains a dot is
// written in brackets, `notifications.events["security.newDevice"]`).
//
// Writing back replaces ONLY the byte span of a literal whose value changed, in
// the quote style it already had. Formatting, comments and key order are never
// touched, so an import with no edits is a byte-identical no-op — the test
// pins that.

import ts from 'typescript';

export const DICT_PATH = 'src/i18n/dictionaries.ts';

function keyName(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return null;
}

function joinPath(parent, seg) {
  const s = String(seg);
  const part = /^[A-Za-z_$][\w$-]*$|^\d+$/.test(s) ? s : `[${JSON.stringify(s)}]`;
  if (!parent) return part;
  return part.startsWith('[') ? `${parent}${part}` : `${parent}.${part}`;
}

function isStringLeaf(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

/** The comment lines written directly above a property — the translator's context. */
function noteFor(text, node) {
  const ranges = ts.getLeadingCommentRanges(text, node.getFullStart()) ?? [];
  const lines = ranges
    .map((r) => text.slice(r.pos, r.end))
    .map((c) => c.replace(/^\/\*+|\*+\/$/g, '').replace(/^\/\/ ?/gm, '').replace(/^\s*\* ?/gm, '').trim())
    .filter(Boolean);
  return lines.length ? lines.join(' ').replace(/\s+/g, ' ') : undefined;
}

/**
 * Parse the dictionary source. Returns, per locale declared as `const <id> = {`
 * or `const <id>: Dict = {`, an ordered Map path → { value, start, end, quote,
 * note }, plus the paths whose value is not a plain string (skipped: never
 * exported, never written).
 */
export function readDictionary(text) {
  const sf = ts.createSourceFile('dictionaries.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const locales = new Map();
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer || !ts.isObjectLiteralExpression(decl.initializer)) continue;
      if (!/^[a-z]{2}(?:_[A-Z]{2})?$/.test(decl.name.text)) continue;
      const entries = new Map();
      const skipped = [];
      const walk = (node, path, note) => {
        if (isStringLeaf(node)) {
          if (entries.has(path)) throw new Error(`duplicate key path ${path}`);
          entries.set(path, {
            value: node.text,
            start: node.getStart(sf),
            end: node.getEnd(),
            quote: ts.isNoSubstitutionTemplateLiteral(node) ? '`' : text[node.getStart(sf)],
            ...(note ? { note } : {}),
          });
          return;
        }
        if (ts.isObjectLiteralExpression(node)) {
          for (const p of node.properties) {
            if (!ts.isPropertyAssignment(p)) {
              skipped.push(joinPath(path, p.name ? keyName(p.name) ?? '?' : '...'));
              continue;
            }
            const k = keyName(p.name);
            if (k === null) {
              skipped.push(joinPath(path, '?'));
              continue;
            }
            walk(p.initializer, joinPath(path, k), noteFor(text, p));
          }
          return;
        }
        if (ts.isArrayLiteralExpression(node)) {
          node.elements.forEach((el, i) => walk(el, joinPath(path, i), undefined));
          return;
        }
        if (ts.isAsExpression(node) || ts.isSatisfiesExpression?.(node) || ts.isParenthesizedExpression(node)) {
          walk(node.expression, path, note);
          return;
        }
        skipped.push(path);
      };
      walk(decl.initializer, '', undefined);
      locales.set(decl.name.text, { entries, skipped, init: { start: decl.initializer.getStart(sf), end: decl.initializer.getEnd() } });
    }
  }
  return locales;
}

/** A string value as a literal in the given quote style. */
export function quoteLiteral(value, quote) {
  const q = quote === '"' ? '"' : "'";
  const body = value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(new RegExp('\\u2028', 'g'), '\\u2028')
    .replace(new RegExp('\\u2029', 'g'), '\\u2029')
    .split(q)
    .join(`\\${q}`);
  return `${q}${body}${q}`;
}

/** `{placeholder}` names in a string, sorted and unique. */
export function placeholders(s) {
  return [...new Set([...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();
}

/**
 * The export document of one locale: every entry of the source locale (English
 * by default) in dictionary order, with the target's current value or
 * `MISSING`. Plain JSON, one key per string, so it diffs and reviews well.
 */
export function buildExport(text, locale, sourceLocale = 'en') {
  const all = readDictionary(text);
  const source = all.get(sourceLocale);
  if (!source) throw new Error(`source locale "${sourceLocale}" not found in the dictionary`);
  const target = all.get(locale);
  const strings = {};
  let missing = 0;
  for (const [path, e] of source.entries) {
    const t = target?.entries.get(path);
    if (!t) missing++;
    strings[path] = {
      source: e.value,
      target: t ? t.value : null,
      ...(t ? {} : { status: 'MISSING' }),
      ...(e.note ? { note: e.note } : {}),
    };
  }
  return {
    meta: {
      format: 'interncrm-i18n/1',
      locale,
      sourceLocale,
      strings: source.entries.size,
      missing,
      howTo: 'Translate `target` only. Keep every {placeholder} exactly as in `source`. Do not add, remove or rename keys. A string still marked "status": "MISSING" or "MT" is not ready to ship.',
    },
    strings,
  };
}

export class ImportRefused extends Error {
  constructor(problems) {
    super(`import refused:\n  - ${problems.slice(0, 40).join('\n  - ')}${problems.length > 40 ? `\n  … and ${problems.length - 40} more` : ''}`);
    this.problems = problems;
  }
}

/**
 * Merge a translator's export document back into the dictionary source.
 * Refuses (throws ImportRefused, writes nothing) when the file would drop a key,
 * names a key the dictionary does not have, leaves a target missing or
 * machine-translated-unreviewed, or changes a string's {placeholders}. Returns
 * the new source text and what changed.
 */
export function applyImport(text, doc, { create = false } = {}) {
  const locale = doc?.meta?.locale;
  if (!locale || typeof doc.strings !== 'object' || doc.strings === null) throw new ImportRefused(['not an export document (meta.locale / strings missing)']);
  const all = readDictionary(text);
  const target = all.get(locale);
  if (!target && create) return createLocaleBlock(text, all, doc);
  if (!target) throw new ImportRefused([`locale "${locale}" has no block in the dictionary yet — import with --create to add it (docs/i18n.md § Adding a locale)`]);
  const sourceLocale = doc.meta.sourceLocale ?? 'en';
  const source = all.get(sourceLocale);

  const problems = [];
  const warnings = [];
  for (const path of target.entries.keys()) {
    if (!(path in doc.strings)) problems.push(`${path}: missing from the file — importing it would drop the key`);
  }
  const changes = [];
  for (const [path, row] of Object.entries(doc.strings)) {
    const cur = target.entries.get(path);
    if (!cur) {
      problems.push(`${path}: not a key of the "${locale}" dictionary`);
      continue;
    }
    if (row?.status === 'MISSING' || row?.target === null || row?.target === undefined) {
      problems.push(`${path}: still MISSING`);
      continue;
    }
    if (row.status === 'MT') {
      problems.push(`${path}: machine translation not reviewed yet (status "MT")`);
      continue;
    }
    if (typeof row.target !== 'string' || row.target.length === 0) {
      problems.push(`${path}: target must be a non-empty string`);
      continue;
    }
    if (row.target === cur.value) continue;
    const src = source?.entries.get(path)?.value ?? cur.value;
    const want = placeholders(src).join(',');
    const got = placeholders(row.target).join(',');
    if (want !== got) {
      problems.push(`${path}: placeholders {${got}} do not match the source's {${want}}`);
      continue;
    }
    if (typeof row.source === 'string' && source && source.entries.get(path)?.value !== row.source) {
      warnings.push(`${path}: the English source changed since this file was exported — re-check the translation`);
    }
    changes.push({ path, start: cur.start, end: cur.end, quote: cur.quote, value: row.target });
  }
  if (problems.length) throw new ImportRefused(problems);

  let out = text;
  for (const c of [...changes].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, c.start) + quoteLiteral(c.value, c.quote) + out.slice(c.end);
  }
  return { text: out, changed: changes.map((c) => c.path), warnings };
}

export const LOCALE_ID = /^[a-z]{2}$/;

/**
 * A new locale's block, built from a COMPLETE translation file: the English
 * block's text with every string literal replaced by its translation (so the
 * new block has exactly the English keys, in the English order, and the `Dict`
 * type checks it like the others), inserted before `export const dictionaries`
 * and added to that map. Refused unless every string is translated and
 * reviewed — a new language never ships with an English or MT hole in it.
 */
function createLocaleBlock(text, all, doc) {
  const locale = doc.meta.locale;
  const sourceLocale = doc.meta.sourceLocale ?? 'en';
  const problems = [];
  if (!LOCALE_ID.test(locale)) problems.push(`"${locale}" is not a two-letter lowercase language code`);
  const source = all.get(sourceLocale);
  if (!source) problems.push(`source locale "${sourceLocale}" not found in the dictionary`);
  if (problems.length) throw new ImportRefused(problems);

  const changes = [];
  for (const [path, e] of source.entries) {
    const row = doc.strings[path];
    if (!row) {
      problems.push(`${path}: missing from the file`);
      continue;
    }
    if (row.status === 'MISSING' || typeof row.target !== 'string' || row.target.length === 0) {
      problems.push(`${path}: still MISSING`);
      continue;
    }
    if (row.status === 'MT') {
      problems.push(`${path}: machine translation not reviewed yet (status "MT")`);
      continue;
    }
    if (placeholders(e.value).join(',') !== placeholders(row.target).join(',')) {
      problems.push(`${path}: placeholders {${placeholders(row.target).join(',')}} do not match the source's {${placeholders(e.value).join(',')}}`);
      continue;
    }
    changes.push({ start: e.start - source.init.start, end: e.end - source.init.start, quote: e.quote === '`' ? "'" : e.quote, value: row.target });
  }
  for (const path of Object.keys(doc.strings)) if (!source.entries.has(path)) problems.push(`${path}: not a key of the dictionary`);

  const MAP = /export const dictionaries: Record<Locale, Dict> = \{([^}]*)\};/;
  const map = MAP.exec(text);
  if (!map) problems.push('could not find `export const dictionaries: Record<Locale, Dict> = { … };`');
  if (problems.length) throw new ImportRefused(problems);

  let block = text.slice(source.init.start, source.init.end);
  for (const c of [...changes].sort((a, b) => b.start - a.start)) {
    block = block.slice(0, c.start) + quoteLiteral(c.value, c.quote) + block.slice(c.end);
  }
  const members = map[1].split(',').map((m) => m.trim()).filter(Boolean);
  const newMap = `export const dictionaries: Record<Locale, Dict> = { ${[...members, locale].join(', ')} };`;
  const at = map.index;
  const out = `${text.slice(0, at)}const ${locale}: Dict = ${block};\n\n${newMap}${text.slice(at + map[0].length)}`;
  return { text: out, changed: [...source.entries.keys()], warnings: [], created: locale };
}

/** `src/i18n/config.ts` with `locale` appended to `locales` (idempotent). */
export function addLocaleToConfig(configText, locale) {
  const RE = /export const locales = \[([^\]]*)\] as const;/;
  const m = RE.exec(configText);
  if (!m) throw new Error('could not find `export const locales = [...] as const;` in the config');
  const ids = [...m[1].matchAll(/'([a-z]{2})'/g)].map((x) => x[1]);
  if (ids.includes(locale)) return configText;
  return configText.replace(RE, `export const locales = [${[...ids, locale].map((l) => `'${l}'`).join(', ')}] as const;`);
}
