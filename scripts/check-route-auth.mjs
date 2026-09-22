#!/usr/bin/env node
// Guard: every exported API handler asks who is calling (#2444).
//
// WHY THIS EXISTS
//   `src/app/api/**` holds ~250 route files and ~375 exported handlers. The one
//   line that makes a handler private — `const session = await
//   getServerSession(authOptions)` and the 401 under it — is a line you add by
//   remembering to. Nothing fails when it is missing: the route compiles, the
//   test that exercises it signs in first and passes, `npm run lint` has no rule
//   for it, and the hole is visible only to somebody who asks the question by
//   hand for all 375 handlers. The two static checks that already existed answer
//   narrower questions — scripts/check-api-key-routes.mjs covers /api/v1 and
//   withApiKey() (#1546), scripts/check-auth-reads.mjs covers which User columns
//   the sign-in path reads (#1150).
//
// WHAT COUNTS AS A GUARD
//   Exactly two calls, reached from the handler body directly or through any
//   function declared in the same file:
//     getServerSession(…)  the NextAuth session — how 537 call sites do it
//     withApiKey(…)        the API-key door, src/lib/apiKey.ts
//   Deliberately nothing else. `requireCapability()` in particular is NOT a
//   guard: it decides what an organisation may do, not who is calling, and
//   accepting it would pass a route that took the orgId out of the request
//   body. Nothing needs it — every file that calls it also opens with
//   getServerSession, so the narrow list costs no false positives today.
//
// WHAT IT DOES NOT CATCH
//   Shapes, not meaning. A handler that calls getServerSession() and then
//   ignores a null session passes here; so does one that reads a session and
//   serves another tenant's row. Those are what e2e/authz-matrix.spec.ts and
//   e2e/authz-idor.spec.ts are for. This guard answers one question only: did
//   anyone ask who is calling?
//
// THE TWO LISTS
//   EXEMPT is a small set of path PATTERNS whose files are not examined at all,
//   and it therefore also covers files added under them later. It is kept to the
//   two cases where examining the file is the wrong thing to do, and an
//   exemption that stops suppressing anything fails the check, so it cannot rot.
//
//   scripts/route-auth-baseline.json is the FROZEN, per-file inventory of
//   handlers that answer anonymously today, each with the reason it may. It is
//   frozen in both directions:
//     * an anonymous handler that is not listed fails — this is the case the
//       guard exists for, and there is no `--update` flag, so the only way to
//       add one is to write the entry and its reason by hand and have a reviewer
//       read it in the diff;
//     * a listed handler that has since gained a guard fails too, asking for the
//       entry to be deleted, so the list can only shrink towards the truth;
//     * an entry naming a file that no longer exists fails for the same reason.
//
// Run: node scripts/check-route-auth.mjs        (npm run check:route-auth)

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { routeFiles } from './lib/route-files.mjs';

const API_DIR = 'src/app/api';
const BASELINE_FILE = 'scripts/route-auth-baseline.json';

/** The HTTP verbs Next treats as route handlers and that can change or read data. */
export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

/** The only two calls that count as "this handler authenticated its caller". */
const GUARDS = /\b(getServerSession|withApiKey)\s*\(/;

// Files this guard does not examine, and why. A pattern ending in `/` matches a
// whole directory; anything else is an exact path.
const EXEMPT = {
  'src/app/api/v1/':
    'the public API has its own, stricter door guard — scripts/check-api-key-routes.mjs ' +
    '(#1546) requires withApiKey() on every /api/v1 route that touches prisma and checks the ' +
    'scope it asks for. Reporting the same routes twice would only teach people to skim.',
  'src/app/api/auth/[...nextauth]/route.ts':
    "NextAuth's own handler, and the one endpoint that MUST answer without a session: it is " +
    'where sessions are issued. It also exports by re-export (`export { handler as GET }`), so ' +
    'there is no handler body to read.',
};

// ---------------------------------------------------------------------------
// Reading TypeScript without a TypeScript parser.
// ---------------------------------------------------------------------------

/**
 * Same-length copy of `source` with comment bodies and string/template contents
 * replaced by spaces. Offsets are preserved, so everything below can brace-match
 * and regex-search without a `{` inside a comment or a `'` inside a string
 * throwing it off — and without a prose mention of getServerSession (there are
 * several, including one that says a route must never have one) reading as a
 * call.
 */
export function codeOnly(source) {
  const out = source.split('');
  const blank = (from, to) => {
    for (let i = from; i < to && i < out.length; i++) if (out[i] !== '\n') out[i] = ' ';
  };
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      let end = source.indexOf('\n', i);
      if (end < 0) end = source.length;
      blank(i, end);
      i = end;
    } else if (c === '/' && next === '*') {
      let end = source.indexOf('*/', i + 2);
      end = end < 0 ? source.length : end + 2;
      blank(i, end);
      i = end - 1;
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === '\\') j += 2;
        else if (source[j] === c) break;
        else j++;
      }
      blank(i + 1, j);
      i = j;
    }
  }
  return out.join('');
}

/** Index of the character closing the `open` at or after `from`, or -1. */
function closeOf(code, from, open, close) {
  const start = code.indexOf(open, from);
  if (start < 0) return [-1, -1];
  let depth = 0;
  for (let i = start; i < code.length; i++) {
    if (code[i] === open) depth++;
    else if (code[i] === close) {
      depth--;
      if (depth === 0) return [start, i];
    }
  }
  return [start, -1];
}

/**
 * Where a function body opens, given the index of the `)` that closed its
 * parameter list. Skips a return-type annotation, which is why this is not
 * simply "the next `{`": `async function requireAdmin(): Promise<{ session:
 * Session } | { error: NextResponse }> {` offers two decoy braces inside the
 * type before the real body, and reading the first one as the body is how an
 * earlier draft of this guard reported eleven guarded admin routes as open.
 */
function bodyBrace(code, afterParams) {
  let angle = 0;
  let paren = 0;
  let square = 0;
  for (let i = afterParams + 1; i < code.length; i++) {
    const c = code[i];
    if (c === '=' && code[i + 1] === '>') {
      i++;
      continue;
    }
    if (c === '<') angle++;
    else if (c === '>') angle = Math.max(0, angle - 1);
    else if (c === '(') paren++;
    else if (c === ')') paren = Math.max(0, paren - 1);
    else if (c === '[') square++;
    else if (c === ']') square = Math.max(0, square - 1);
    else if (angle === 0 && paren === 0 && square === 0) {
      if (c === '{') return i;
      // A declaration with no body (`declare function f(): void;`) or an
      // assignment to something that is not a function literal.
      if (c === ';') return -1;
    }
  }
  return -1;
}

/** The body text of the function whose parameter list opens at `parenIdx`. */
function bodyAt(code, parenIdx) {
  const [, paramsEnd] = closeOf(code, parenIdx, '(', ')');
  if (paramsEnd < 0) return null;
  const brace = bodyBrace(code, paramsEnd);
  if (brace < 0) return null;
  const [start, end] = closeOf(code, brace, '{', '}');
  if (end < 0) return null;
  return code.slice(start, end + 1);
}

/** Every named function/arrow declared at any level of the file → its body. */
function localFunctions(code) {
  const locals = new Map();
  const declaration = /(?:^|[\s;}])(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*(?:<[^>(]*>)?\s*\(/g;
  for (const m of code.matchAll(declaration)) {
    const body = bodyAt(code, m.index + m[0].length - 1);
    if (body !== null) locals.set(m[1], body);
  }
  const assignment = /(?:^|[\s;}])(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=\s*(?:async\s*)?\(/g;
  for (const m of code.matchAll(assignment)) {
    if (locals.has(m[1])) continue;
    const body = bodyAt(code, m.index + m[0].length - 1);
    if (body !== null) locals.set(m[1], body);
  }
  return locals;
}

/**
 * Does this body reach a guard — itself, or through a function declared in the
 * same file? Handlers in this tree delegate constantly (`requireAdmin()` in
 * eleven admin routes, `handleGet()` wherever the request context is bound
 * first), so a check that only read the handler's own body would be wrong about
 * a third of the surface.
 */
function reachesGuard(body, locals, seen) {
  if (GUARDS.test(body)) return true;
  for (const [name, otherBody] of locals) {
    if (seen.has(name)) continue;
    if (!new RegExp(`\\b${name}\\s*\\(`).test(body)) continue;
    seen.add(name);
    if (reachesGuard(otherBody, locals, seen)) return true;
  }
  return false;
}

/**
 * Classify one route file's source.
 * @param {string} source the file's TypeScript
 * @returns {{ handlers: {method: string, guarded: boolean}[], unreadable: string[] }}
 *   `unreadable` names methods the file exports that this reader could not find
 *   a body for — an unrecognised handler shape, which fails rather than passing
 *   silently, because a shape the guard cannot read is a shape it cannot guard.
 */
export function analyzeRoute(source) {
  const code = codeOnly(source);
  const locals = localFunctions(code);

  // Every method name the file exports, whatever the shape.
  const exported = new Set();
  for (const m of code.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) {
    if (HTTP_METHODS.includes(m[1])) exported.add(m[1]);
  }
  for (const m of code.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
    if (HTTP_METHODS.includes(m[1])) exported.add(m[1]);
  }
  // `export { handler as GET, handler as POST }` and `export { GET }`.
  for (const m of code.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim() ?? '';
      if (HTTP_METHODS.includes(name)) exported.add(name);
    }
  }

  const handlers = [];
  const read = new Set();
  const handlerDecl = /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\s*\(/g;
  for (const m of code.matchAll(handlerDecl)) {
    const body = bodyAt(code, m.index + m[0].length - 1);
    if (body === null) continue;
    read.add(m[1]);
    handlers.push({ method: m[1], guarded: reachesGuard(body, locals, new Set([m[1]])) });
  }

  const unreadable = [...exported].filter((method) => !read.has(method)).sort();
  handlers.sort((a, b) => HTTP_METHODS.indexOf(a.method) - HTTP_METHODS.indexOf(b.method));
  return { handlers, unreadable };
}

// ---------------------------------------------------------------------------
// The check.
// ---------------------------------------------------------------------------

/** The exemption pattern covering `file`, or undefined. */
export function exemptionFor(file, patterns = EXEMPT) {
  for (const pattern of Object.keys(patterns)) {
    if (pattern.endsWith('/') ? file.startsWith(pattern) : file === pattern) return pattern;
  }
  return undefined;
}

function main() {
  const baseline = JSON.parse(readFileSync(BASELINE_FILE, 'utf8'));
  const problems = [];
  const missing = new Map(); // file -> methods that need a baseline entry
  const usedExemptions = new Set();
  const analysed = new Map(); // file -> Set of methods this reader could judge
  let examined = 0;
  let anonymous = 0;

  const walked = new Set(routeFiles(API_DIR));

  for (const file of walked) {
    const exemption = exemptionFor(file);
    const { handlers, unreadable } = analyzeRoute(readFileSync(file, 'utf8'));
    const entry = baseline[file];
    const allowed = new Set(Array.isArray(entry?.methods) ? entry.methods : []);

    if (unreadable.length > 0) {
      if (exemption) usedExemptions.add(exemption);
      else
        problems.push(
          `${file}  exports ${unreadable.join(', ')} in a shape this guard cannot read, so it ` +
            'cannot tell whether the handler authenticates. Declare it as an ordinary exported ' +
            'async function, or add the file to EXEMPT in scripts/check-route-auth.mjs with the ' +
            'reason it cannot be one.',
        );
      if (handlers.length === 0) continue;
    }
    if (exemption) {
      if (handlers.some((h) => !h.guarded)) usedExemptions.add(exemption);
      continue;
    }
    examined++;
    analysed.set(file, new Set(handlers.map((h) => h.method)));

    for (const { method, guarded } of handlers) {
      if (guarded) {
        if (allowed.has(method)) {
          problems.push(
            `${file}  ${method} now authenticates, but is still listed in ${BASELINE_FILE}. ` +
              'Remove it from the entry (and the whole entry when it is the last method) — the ' +
              'baseline records what is open, so it may only shrink.',
          );
        }
        continue;
      }
      anonymous++;
      if (allowed.has(method)) continue;
      if (!missing.has(file)) missing.set(file, []);
      missing.get(file).push(method);
    }
  }

  for (const [file, methods] of missing) {
    problems.push(
      `${file}  ${methods.join(', ')} answer${methods.length === 1 ? 's' : ''} without calling ` +
        'getServerSession() or withApiKey(), directly or through a function in the same file. ' +
        'Add the guard — or, if the route is public by design, record it in ' +
        `${BASELINE_FILE} with the reason:\n` +
        `      ${JSON.stringify(file)}: { "methods": ${JSON.stringify(methods)}, "why": "…" }`,
    );
  }

  // The baseline may not name a file that is gone, or a method that is not open
  // any more: a stale line reads as a reviewed decision it no longer is.
  for (const [file, entry] of Object.entries(baseline)) {
    if (file.startsWith('_')) continue;
    if (!existsSync(file)) {
      problems.push(`${BASELINE_FILE} names ${file}, which no longer exists — delete the entry.`);
      continue;
    }
    if (!walked.has(file)) {
      problems.push(
        `${BASELINE_FILE} names ${file}, which is not a route file under ${API_DIR} — an entry ` +
          'that matches nothing excuses nothing, and reads like it does.',
      );
      continue;
    }
    if (typeof entry?.why !== 'string' || entry.why.trim().length < 20) {
      problems.push(
        `${BASELINE_FILE} entry for ${file} has no usable "why" — every open route states, in ` +
          'the entry, what stands in for the session (a signed token, a shared secret, or ' +
          '"nothing, it is public and carries no personal data").',
      );
    }
    for (const method of entry?.methods ?? []) {
      if (!HTTP_METHODS.includes(method)) {
        problems.push(`${BASELINE_FILE} entry for ${file} lists ${method}, which is not an HTTP handler.`);
      } else if (analysed.has(file) && !analysed.get(file).has(method)) {
        problems.push(
          `${BASELINE_FILE} entry for ${file} lists ${method}, which the file does not export — ` +
            'delete it.',
        );
      }
    }
  }

  for (const [pattern, reason] of Object.entries(EXEMPT)) {
    if (!usedExemptions.has(pattern)) {
      problems.push(
        `EXEMPT in scripts/check-route-auth.mjs still excuses ${pattern} ("${reason.slice(0, 60)}…"), ` +
          'but nothing under it would be reported any more — delete the exemption so the list ' +
          'stays the short one a reviewer actually reads.',
      );
    }
  }

  if (problems.length > 0) {
    console.error('route auth FAILED — an API handler must authenticate its caller (#2444):\n');
    for (const problem of problems) console.error(`  • ${problem}\n`);
    console.error(
      `A guard is getServerSession(authOptions) or withApiKey(), in the handler or in a function ` +
        `it calls in the same file. Public-by-design routes live in ${BASELINE_FILE}, one reason ` +
        'each; it is written by hand on purpose.',
    );
    process.exit(1);
  }

  console.log(
    `route auth OK — ${examined} route file(s) examined, every exported handler reaches ` +
      `getServerSession() or withApiKey() except the ${anonymous} recorded in ${BASELINE_FILE}, ` +
      `plus ${Object.keys(EXEMPT).length} exempt path pattern(s).`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
