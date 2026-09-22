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
//   Shapes, not meaning. The question this answers is exactly one: does the
//   handler ask who is calling AT ALL? A handler that calls getServerSession()
//   and then ignores a null session passes; so does one that reads a session
//   and serves another tenant's row; so does one that reads the session only on
//   a branch and answers anonymous callers on the other (/api/health and
//   /api/profile-view both do, on purpose — they are annotated in the
//   `_conditional` section of the baseline so the file does not read as a claim
//   it cannot support). Meaning is what e2e/authz-matrix.spec.ts and
//   e2e/authz-idor.spec.ts are for.
//
// WHY A SCANNER MISTAKE IS LOUD
//   This reads TypeScript without a TypeScript parser, so it can be wrong. It
//   is built so that being wrong costs a red build and never a silent pass:
//   the set of exported handler names is taken from the RAW source as well as
//   from the blanked copy, and any method in the raw set that the reader could
//   not find a body for is reported as unreadable. So a comment or a regex
//   literal that confuses the blanking can only ever hide a handler from the
//   *reader*, never from the *report*. (#2444 review: `const RE = /[']/g;`
//   between two handlers used to blank the second `export async function POST`
//   away entirely, and the check passed with the handler in neither list.)
//
// THE THREE LISTS
//   EXEMPT is a small set of path PATTERNS whose files are not examined at all,
//   and it therefore also covers files added under them later. It is kept to the
//   two cases where examining the file is the wrong thing to do, and an
//   exemption that stops suppressing anything fails the check, so it cannot rot.
//
//   scripts/route-auth-baseline.json is the FROZEN, per-file inventory of
//   handlers that NEVER ask who is calling, each with the reason they may. It is
//   frozen in both directions:
//     * an anonymous handler that is not listed fails — this is the case the
//       guard exists for, and there is no `--update` flag, so the only way to
//       add one is to write the entry and its reason by hand and have a reviewer
//       read it in the diff;
//     * a listed handler that has since gained a guard fails too, asking for the
//       entry to be deleted, so the list can only shrink towards the truth;
//     * an entry naming a file that no longer exists fails for the same reason.
//
//   Its `_conditional` section is the hand-kept annotation of handlers that DO
//   ask, but answer anonymous callers on some branch — the ones the shape check
//   is structurally unable to find. It cannot be complete (that would need a
//   reader of meaning), but it cannot rot either: every entry must name a live
//   route file, a method that file exports, a method the guard still judges
//   guarded, and a reason.
//
// Run: node scripts/check-route-auth.mjs        (npm run check:route-auth)

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { routeFiles } from './lib/route-files.mjs';

const API_DIR = 'src/app/api';
const BASELINE_FILE = 'scripts/route-auth-baseline.json';

/**
 * The HTTP verbs Next treats as route handlers. HEAD and OPTIONS are in the
 * list although no route in this tree exports either: an OPTIONS handler that
 * reads a row is exactly as exposed as a GET, and a verb the guard does not
 * know about is waved through with no message — the one failure mode this
 * script is built not to have.
 */
export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

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

/** Characters after which a `/` opens a regex literal rather than dividing. */
const BEFORE_REGEX = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '^', '~', '<', '>', '\n']);
/** Keywords after which the same is true (`return /x/.test(s)`). */
const BEFORE_REGEX_WORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'case', 'do', 'else', 'yield', 'await',
]);

/** Does the `/` at `i` open a regex literal, reading backwards from it? */
function opensRegex(source, i) {
  let j = i - 1;
  while (j >= 0 && (source[j] === ' ' || source[j] === '\t')) j--;
  if (j < 0) return true;
  const c = source[j];
  if (BEFORE_REGEX.has(c)) return true;
  if (!/[\w$]/.test(c)) return false;
  let k = j;
  while (k >= 0 && /[\w$]/.test(source[k])) k--;
  return BEFORE_REGEX_WORDS.has(source.slice(k + 1, j + 1));
}

/**
 * Same-length copy of `source` with comment bodies, string/template contents and
 * regex-literal contents replaced by spaces. Offsets are preserved, so
 * everything below can brace-match and regex-search without a `{` inside a
 * comment, a `'` inside a string or a `'` inside a character class throwing it
 * off — and without a prose mention of getServerSession (there are several,
 * including one that says a route must never have one) reading as a call.
 *
 * The regex branch uses the usual look-behind heuristic and can therefore be
 * wrong in either direction on pathological input. Both directions are safe:
 * over-blanking hides a guard or a closing brace and the handler is reported,
 * under-blanking hides a handler from the reader and analyzeRoute's raw-source
 * cross-check reports it as unreadable. Neither can pass a handler silently.
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
    } else if (c === '/' && opensRegex(source, i)) {
      let j = i + 1;
      let inClass = false;
      for (; j < source.length; j++) {
        const d = source[j];
        if (d === '\\') j++;
        else if (d === '\n') break; // unterminated: it was division after all
        else if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) break;
      }
      if (j < source.length && source[j] === '/') {
        blank(i + 1, j);
        i = j;
      }
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

/** Every HTTP method name `text` exports, in any of the three shapes. */
function exportedMethods(text) {
  const found = new Set();
  for (const m of text.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) {
    if (HTTP_METHODS.includes(m[1])) found.add(m[1]);
  }
  for (const m of text.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
    if (HTTP_METHODS.includes(m[1])) found.add(m[1]);
  }
  // `export { handler as GET, handler as POST }` and `export { GET }`.
  for (const m of text.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim() ?? '';
      if (HTTP_METHODS.includes(name)) found.add(name);
    }
  }
  return found;
}

const HANDLER_DECL = new RegExp(`export\\s+(?:async\\s+)?function\\s+(${HTTP_METHODS.join('|')})\\s*\\(`, 'g');

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

  // The union of what the blanked copy exports and what the RAW text does. The
  // raw half is the one that matters: it is computed from text nothing has
  // blanked, so no confusion inside codeOnly can make a handler disappear from
  // the report. The price is that an `export async function GET(` written out
  // inside a comment or a string in a route file is reported as unreadable —
  // a loud false positive, which is the direction to be wrong in.
  const exported = new Set([...exportedMethods(code), ...exportedMethods(source)]);

  const handlers = [];
  const read = new Set();
  HANDLER_DECL.lastIndex = 0;
  for (const m of code.matchAll(HANDLER_DECL)) {
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

/**
 * The decision layer, separated from the filesystem so the ratchet itself can
 * be tested — it is the half with the security value, and the half a later
 * refactor (an `--update` flag, a relaxed staleness rule) would quietly break.
 *
 * @param {object} input
 * @param {string[]} input.files route files to examine, as routeFiles() returns them
 * @param {(file: string) => string} input.read source of one file
 * @param {object} input.baseline parsed scripts/route-auth-baseline.json
 * @param {Record<string,string>} [input.exempt] path patterns → reason
 * @param {(file: string) => boolean} [input.exists] does this path exist on disk
 * @returns {{ problems: string[], examined: number, anonymous: number }}
 */
export function checkTree({ files, read, baseline, exempt = EXEMPT, exists = existsSync }) {
  const problems = [];
  const missing = new Map(); // file -> methods that need a baseline entry
  const usedExemptions = new Set();
  const analysed = new Map(); // file -> Map(method -> guarded)
  let examined = 0;
  let anonymous = 0;

  const walked = new Set(files);

  for (const file of walked) {
    const exemption = exemptionFor(file, exempt);
    const { handlers, unreadable } = analyzeRoute(read(file));
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
    analysed.set(file, new Map(handlers.map((h) => [h.method, h.guarded])));

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

  /** Shared shape rules for both sections of the baseline. */
  const checkEntry = (section, file, entry) => {
    if (!exists(file)) {
      problems.push(`${BASELINE_FILE}${section} names ${file}, which no longer exists — delete the entry.`);
      return false;
    }
    if (!walked.has(file)) {
      problems.push(
        `${BASELINE_FILE}${section} names ${file}, which is not a route file under ${API_DIR} — an ` +
          'entry that matches nothing excuses nothing, and reads like it does.',
      );
      return false;
    }
    if (typeof entry?.why !== 'string' || entry.why.trim().length < 20) {
      problems.push(
        `${BASELINE_FILE}${section} entry for ${file} has no usable "why" — every open route states, ` +
          'in the entry, what stands in for the session (a signed token, a shared secret, or ' +
          '"nothing, it is public and carries no personal data").',
      );
    }
    return true;
  };

  // The baseline may not name a file that is gone, or a method that is not open
  // any more: a stale line reads as a reviewed decision it no longer is.
  for (const [file, entry] of Object.entries(baseline)) {
    if (file.startsWith('_')) continue;
    if (!checkEntry('', file, entry)) continue;
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

  // `_conditional` annotates handlers that DO authenticate but answer anonymous
  // callers on a branch — invisible to a shape check, so the section is written
  // by hand. It is held to the same "cannot rot" rules, plus one of its own: a
  // method listed here must still be judged guarded, or it belongs in the
  // frozen list above where the ratchet can see it.
  for (const [file, entry] of Object.entries(baseline._conditional ?? {})) {
    if (file.startsWith('_')) continue;
    if (baseline[file]) {
      problems.push(
        `${BASELINE_FILE} lists ${file} in both the frozen baseline and _conditional — a handler ` +
          'either never asks who is calling or asks and answers anyway; it cannot be both.',
      );
      continue;
    }
    if (!checkEntry(' _conditional', file, entry)) continue;
    for (const method of entry?.methods ?? []) {
      if (!HTTP_METHODS.includes(method)) {
        problems.push(
          `${BASELINE_FILE} _conditional entry for ${file} lists ${method}, which is not an HTTP handler.`,
        );
      } else if (analysed.has(file) && !analysed.get(file).has(method)) {
        problems.push(
          `${BASELINE_FILE} _conditional entry for ${file} lists ${method}, which the file does not ` +
            'export — delete it.',
        );
      } else if (analysed.has(file) && analysed.get(file).get(method) === false) {
        problems.push(
          `${BASELINE_FILE} _conditional entry for ${file} says ${method} authenticates on some ` +
            'branch, but it no longer calls getServerSession() or withApiKey() at all — move it to ' +
            'the frozen baseline above, where the ratchet counts it.',
        );
      }
    }
  }

  for (const [pattern, reason] of Object.entries(exempt)) {
    if (!usedExemptions.has(pattern)) {
      problems.push(
        `EXEMPT in scripts/check-route-auth.mjs still excuses ${pattern} ("${reason.slice(0, 60)}…"), ` +
          'but nothing under it would be reported any more — delete the exemption so the list ' +
          'stays the short one a reviewer actually reads.',
      );
    }
  }

  return { problems, examined, anonymous };
}

function main() {
  const baseline = JSON.parse(readFileSync(BASELINE_FILE, 'utf8'));
  const { problems, examined, anonymous } = checkTree({
    files: routeFiles(API_DIR),
    read: (file) => readFileSync(file, 'utf8'),
    baseline,
  });

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
