#!/usr/bin/env node
// Which dictionary namespaces each part of the app ships to the browser.
//
// WHY THIS EXISTS
//   The root layout used to hand the WHOLE client dictionary (≈430 KB of JSON
//   per locale, 265 namespaces) to every page, so /features — a page that reads
//   a handful of strings — was ~686 KB of HTML, most of it dictionary, serialized
//   and gzipped again on every request. On the shared box that was the cost the
//   nightly k6 run kept hitting (#2987).
//
//   Now the root layout ships only the SHELL namespaces (what the root layout,
//   the providers and the root not-found page can reach), and every top-level
//   directory of src/app gets a layout that adds the namespaces ITS files can
//   reach (`<I18nScope scope="…">`, src/i18n/scope.tsx). App Router keeps the
//   root layout across client navigations, which is exactly why the split cannot
//   be decided by path in the root layout: a trimmed root dict would outlive the
//   page it was trimmed for. Segment layouts are re-rendered per segment, so the
//   dictionary follows the navigation.
//
// HOW THE SETS ARE COMPUTED
//   Static and deliberately OVER-inclusive: from each scope's entry files, walk
//   the import graph inside src/, and count a namespace as used when its name
//   appears as a property access (`.ns`, `?.ns`) or as a string literal
//   (`'ns'`, `'ns.key'`). A false positive ships a few KB too much; a false
//   negative would render an empty string, so the scan errs one way only. The
//   dictionary modules themselves are not scanned — they name every namespace.
//
// USAGE
//   node scripts/i18n-scopes.mjs           # write src/i18n/scopes.generated.ts
//   node scripts/i18n-scopes.mjs --check   # CI: a scope that is not mounted → exit 1
//
// The manifest is NOT committed (.gitignore). `npm install` (postinstall),
// `npm run dev` and `npm run build` write it, so it always matches the tree it
// was generated from — and a dozen parallel PRs that each add a namespace
// cannot conflict on it or leave main with a stale copy. Plain ESM on purpose:
// the build runs inside the Node 20 Docker image, which cannot import TS.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SRC = path.join(ROOT, 'src');
const APP = path.join(SRC, 'app');
const DICT = path.join(SRC, 'i18n', 'dictionaries.ts');
const OUT = path.join(SRC, 'i18n', 'scopes.generated.ts');
const CHECK = process.argv.includes('--check');

// Never scanned for tokens and never followed: they spell out every namespace.
const OPAQUE = new Set(
  ['i18n/dictionaries.ts', 'i18n/verticalOverlays.ts', 'i18n/emailDictionary.ts', 'i18n/scopes.generated.ts'].map((p) =>
    path.join(SRC, p),
  ),
);

// ── Namespaces, read from the source (no TS import: see the header) ──────────
function readNamespaces() {
  const lines = fs.readFileSync(DICT, 'utf8').split('\n');
  const start = lines.findIndex((l) => /^const en = \{/.test(l));
  if (start < 0) throw new Error('i18n-scopes: `const en = {` not found in dictionaries.ts');
  const names = [];
  for (let i = start + 1; i < lines.length && !/^\};/.test(lines[i]); i++) {
    const m = /^ {2}([A-Za-z_$][\w$]*): /.exec(lines[i]);
    if (m) names.push(m[1]);
  }
  const so = /SERVER_ONLY_NAMESPACES = \[([^\]]*)\]/.exec(lines.join('\n'));
  if (!so) throw new Error('i18n-scopes: SERVER_ONLY_NAMESPACES not found in dictionaries.ts');
  const serverOnly = new Set([...so[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
  if (names.length < 50) throw new Error(`i18n-scopes: read only ${names.length} namespaces — has the en block moved?`);
  return { client: new Set(names.filter((n) => !serverOnly.has(n))), serverOnly };
}

// ── Import graph ─────────────────────────────────────────────────────────────
const EXT = ['.tsx', '.ts', '.jsx', '.js', '.mjs'];
function resolveImport(from, spec) {
  let base;
  if (spec.startsWith('@/')) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(from), spec);
  else return null; // a package — outside the app's own strings
  const tries = [base, ...EXT.map((e) => base + e), ...EXT.map((e) => path.join(base, 'index' + e))];
  for (const t of tries) if (fs.existsSync(t) && fs.statSync(t).isFile()) return t;
  return null;
}

const IMPORT_RE = [
  /(?:^|[\s;])import\s+(?!type\s)(?:[^'"`;]*?\sfrom\s*)?['"]([^'"]+)['"]/g,
  /(?:^|[\s;])export\s+(?!type\s)[^'"`;]*?\sfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
];
const TOKEN_RE = [/(?:\?\.|\.)\s*([A-Za-z_$][\w$]*)/g, /['"`]([A-Za-z_$][\w$]*)(?=[.'"`])/g];

const fileCache = new Map();
function scanFile(file) {
  let hit = fileCache.get(file);
  if (hit) return hit;
  const text = fs.readFileSync(file, 'utf8');
  const imports = new Set();
  for (const re of IMPORT_RE) for (const m of text.matchAll(re)) {
    const r = resolveImport(file, m[1]);
    if (r && !OPAQUE.has(r)) imports.add(r);
  }
  const tokens = new Set();
  for (const re of TOKEN_RE) for (const m of text.matchAll(re)) tokens.add(m[1]);
  hit = { imports, tokens, client: USE_CLIENT.test(text) };
  fileCache.set(file, hit);
  return hit;
}

// Only the CLIENT module graph can read the client dictionary: it reaches a
// component through useT(), a hook, and a server component never calls it (it
// reads getServerDictionary(), the full dictionary, on the server). So server
// files are walked only to find the client components they render, and tokens
// are collected from a file once it is on the client side of a boundary — it
// says 'use client', or a client file imports it.
const USE_CLIENT = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*['"]use client['"]/;
function reachableTokens(entries, why) {
  const seen = new Set();
  const stack = entries.filter((f) => !OPAQUE.has(f)).map((f) => [f, false]);
  const tokens = new Set();
  while (stack.length) {
    const [f, parentClient] = stack.pop();
    const { imports, tokens: t, client: own } = scanFile(f);
    const client = parentClient || own;
    const key = `${client ? 'c' : 's'}:${f}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (client) {
      for (const x of t) tokens.add(x);
      if (why && t.has(why)) console.error(`  ${why} ← ${path.relative(ROOT, f)}`);
    }
    for (const i of imports) stack.push([i, client]);
  }
  return tokens;
}

// ── Scopes ───────────────────────────────────────────────────────────────────
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const isRendered = (f) => /\.(tsx|ts|jsx|js)$/.test(f) && !/\/route\.(ts|js)$/.test(f) && !/\.(test|spec)\./.test(f);

// The shell: what renders around EVERY page, before any segment layout.
const SHELL_FILES = ['layout.tsx', 'providers.tsx', 'not-found.tsx', 'error.tsx', 'loading.tsx', 'template.tsx']
  .map((f) => path.join(APP, f))
  .filter((f) => fs.existsSync(f));

// One scope per top-level directory of src/app that renders a page (route
// groups included — `(unstreamed)/admin` is not under `admin/layout.tsx`), plus
// `home` for the root page, which has no directory of its own.
function scopeRoots() {
  const roots = [];
  for (const e of fs.readdirSync(APP, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name === 'api' || e.name.startsWith('_')) continue;
    const files = walk(path.join(APP, e.name));
    if (!files.some((f) => /\/page\.(tsx|ts|jsx|js)$/.test(f))) continue;
    roots.push({ id: e.name, dir: path.join(APP, e.name), entries: files.filter(isRendered) });
  }
  roots.sort((a, b) => (a.id < b.id ? -1 : 1));
  return roots;
}

function build() {
  const { client } = readNamespaces();
  const pick = (tokens) => [...client].filter((n) => tokens.has(n)).sort();
  const shell = pick(reachableTokens(SHELL_FILES));
  const shellSet = new Set(shell);
  const scopes = {};
  const home = path.join(APP, 'page.tsx');
  if (fs.existsSync(home)) scopes.home = pick(reachableTokens([home])).filter((n) => !shellSet.has(n));
  const roots = scopeRoots();
  for (const r of roots) scopes[r.id] = pick(reachableTokens(r.entries)).filter((n) => !shellSet.has(n));
  return { shell, scopes, roots, total: client.size };
}

function render({ shell, scopes, total }) {
  const list = (a, pad) => (a.length ? `[\n${a.map((n) => `${pad}  '${n}',`).join('\n')}\n${pad}]` : '[]');
  const body = Object.entries(scopes)
    .map(([id, ns]) => `  '${id}': ${list(ns, '  ')},`)
    .join('\n');
  return `// GENERATED by scripts/i18n-scopes.mjs on install, dev and build — not committed, do not edit.
// ${total} client namespaces; the root layout ships SHELL_NAMESPACES, each top-level
// directory of src/app adds its own through <I18nScope scope="…"> (src/i18n/scope.tsx).

export const SHELL_NAMESPACES: readonly string[] = ${list(shell, '')};

export const SCOPE_NAMESPACES = {
${body}
} as const satisfies Record<string, readonly string[]>;

export type I18nScopeId = keyof typeof SCOPE_NAMESPACES;
`;
}

// Every scope must actually be mounted, or its pages would render with the
// shell alone: `home` in src/app/page.tsx, every other scope in its
// directory's layout.tsx.
function coverageProblems(roots) {
  const problems = [];
  const mounted = (file, id) =>
    fs.existsSync(file) && new RegExp(`<I18nScope\\s+scope=["']${id.replace(/[()]/g, '\\$&')}["']`).test(fs.readFileSync(file, 'utf8'));
  if (!mounted(path.join(APP, 'page.tsx'), 'home')) problems.push('src/app/page.tsx does not render <I18nScope scope="home">');
  for (const r of roots) {
    const layout = path.join(r.dir, 'layout.tsx');
    if (!mounted(layout, r.id)) problems.push(`src/app/${r.id}/layout.tsx does not render <I18nScope scope="${r.id}">`);
  }
  return problems;
}

const WHY = process.argv.find((a) => a.startsWith('--why='))?.slice(6);
if (WHY) {
  // Debugging aid: which reachable files name a namespace, per scope.
  const scope = process.argv.find((a) => a.startsWith('--scope='))?.slice(8) ?? 'shell';
  const entries = scope === 'shell' ? SHELL_FILES : scope === 'home' ? [path.join(APP, 'page.tsx')] : scopeRoots().find((r) => r.id === scope)?.entries ?? [];
  reachableTokens(entries, WHY);
  process.exit(0);
}
const result = build();
const text = render(result);
if (CHECK) {
  const problems = coverageProblems(result.roots);
  fs.writeFileSync(OUT, text); // keep the working copy in step for the tsc that follows
  if (problems.length) {
    console.error('check:i18n-scopes failed:\n' + problems.map((p) => `  - ${p}`).join('\n'));
    process.exit(1);
  }
  console.log(`check:i18n-scopes OK — shell ${result.shell.length}/${result.total} namespaces, ${Object.keys(result.scopes).length} scopes`);
} else {
  fs.writeFileSync(OUT, text);
  const sizes = Object.entries(result.scopes).map(([id, ns]) => `${id}:${ns.length}`).join(' ');
  console.log(`i18n-scopes: shell ${result.shell.length}/${result.total}; ${sizes}`);
}
