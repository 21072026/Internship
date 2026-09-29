#!/usr/bin/env node
// Guard: a User lookup by e-mail must say WHICH WORLD it means (#2590).
//
// WHY THIS EXISTS
//   `User.email` is no longer unique. One person is one row PER WORLD — the same
//   mailbox may hold an internship account and a marketing account, two rows in
//   two tenants — and the URL they signed in on decides which of them they are
//   (docs/worlds.md, src/lib/userWorld.ts). So
//
//     prisma.user.findFirst({ where: { email } })
//
//   no longer means "the account of this e-mail", it means "ONE of them,
//   whichever the database returns first". It type-checks, it passes every
//   single-world test, and in production it signs a person into the wrong
//   product, resets the wrong account's password, mails a link into the wrong
//   product, or hands one tenant another tenant's row. Prisma's types already
//   refuse `findUnique({ where: { email } })` now; the reflex fix is to swap in a
//   `findFirst`, which is exactly the bug — the compiler cannot tell the two
//   apart, this can.
//
// WHAT COUNTS
//   A call `<anything>.user.<method>(…)` — method one of findFirst, findMany,
//   findUnique, findUniqueOrThrow, findFirstOrThrow, count, update, updateMany,
//   delete, deleteMany, upsert — whose `where` has an `email` key: at the top
//   level, or inside an `AND`/`OR` member reached from it. `email: { contains }`
//   (also startsWith / endsWith / search) is a SEARCH box, not an identity
//   lookup — it cannot name "the" account, so no world question arises there —
//   and does not count.
//
//   (The compound unique `email_orgId: { email, orgId }` has no top-level `email`
//   key, so it is never a lookup by this rule — it names its org by construction.)
//
//   Such a call is fine when its `where` also names the world, i.e. it is
//   PINNED. Pinned means one of, in the same conjunction as the email:
//     orgId / org           the tenant, and so the world (worlds are derived
//                           from the organization's vertical)
//     id                    a primary key: exactly one row, no world to guess
//     …worldUserWhere(w)    the helper in src/lib/userWorld.ts
//     tenantWhere(…) / withinTenant(…) / orgScoped(…)
//                           the hand-written tenant filters (they are an `orgId`)
//   Under `OR` a pin only counts when EVERY branch carries one — an email
//   branch next to an unpinned branch can still return the other world's row.
//   `orgId: undefined` and `id: { not: … }` are not pins (Prisma reads
//   `undefined` as "no filter").
//
//   Two things are exempt by construction, and one by a written reason:
//     • src/lib/userWorld.ts — the ONE module whose job is to turn an e-mail
//       into a row (its `findUsersByEmail` is the explicit "any world" door);
//     • test files and node_modules;
//     • an entry in EXEMPT below, WITH its reason, for a call whose job really is
//       to act across worlds. Same discipline as check-tenant-models.mjs: the
//       exception lives here, next to the rule, never in a comment somewhere
//       else — and it is a RATCHET: the entry states how many calls it excuses in
//       that file, so a NEW unpinned lookup added next to an excused one still
//       fails, and an excuse that stops being needed fails too.
//
// WHAT IT DOES NOT CATCH (say so, rather than let green read as more than it is)
//   Shapes, not meaning. It reads `where` objects written in the call, or in a
//   `const where = { … }` earlier in the same file. It does not follow a `where`
//   received as a parameter or built up by `where.email = …` afterwards (those
//   are counted and printed as "unread"), it does not look at relation filters
//   (`mentee: { email }` on another model), and it does not read raw SQL. It says
//   nothing about `create`: the rule there — call `emailTakenInWorld()` first —
//   is a different question. A pin that is present but wrong (the wrong org's
//   id) is what the e2e specs are for.
//
// It reads TypeScript without a parser, like scripts/check-route-auth.mjs, and is
// built so a mistake is loud: an unbalanced call or an unreadable `where` is
// reported, never silently treated as clean. scripts/test/check-user-email-lookups
// .test.mjs pins both directions on fixture strings.
//
// Run: node scripts/check-user-email-lookups.mjs [--explain]   (npm run check:user-email-lookups)
//      --explain prints the verdict for every User call it read.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOTS = ['src', 'prisma', 'scripts'];
const SOURCE_FILE = /\.(?:[cm]?js|[cm]?ts|tsx)$/;
const TEST_FILE = /\.(?:test|spec)\.[^/]+$/;
const SKIP_DIRS = new Set(['node_modules', '.next', '__tests__']);
// `scripts/test/` is the unit-test directory; it is skipped by path, not by the
// name `test`, so a route directory called `test` would still be read.
const SKIP_PATHS = ['scripts/test/'];

/** The one module allowed to turn an e-mail into a row — see the header. */
export const LOOKUP_API = 'src/lib/userWorld.ts';

export const METHODS = [
  'findFirst',
  'findMany',
  'findUnique',
  'findUniqueOrThrow',
  'findFirstOrThrow',
  'count',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
  'upsert',
];

// Keys of a `where` that name the world (or a single row) — see the header.
const PIN_KEYS = new Set(['orgId', 'org', 'id']);
// Calls that produce a pinned fragment. `withinTenant(where, tenant)` and
// `orgScoped(where, …)` wrap a caller's own `where` (their first argument),
// which is still read for an `email` key; the other two ARE the fragment.
const PIN_FRAGMENT_CALLS = ['worldUserWhere', 'tenantWhere'];
const PIN_WRAPPER_CALLS = ['withinTenant', 'orgScoped'];
// `email: { … }` operators that make it a search, not an identity.
const SEARCH_OPERATORS = new Set(['contains', 'startsWith', 'endsWith', 'search', 'mode']);

// ── Exemptions ───────────────────────────────────────────────────────────────
// file → { calls, reason }. `calls` is how many unpinned e-mail lookups the file
// is allowed to hold; the check fails when the file has more (a new one slipped
// in next to an excused one) OR fewer (the excuse is stale — delete it).
// A reason says why crossing worlds is the point of THAT call; "not yet fixed" is
// not a reason, it is a red build.
export const EXEMPT = new Map([
  [
    'src/app/api/account/2fa/route.ts',
    {
      calls: 1,
      // `id: { not: self }` is deliberately NOT a pin (it admits every other row),
      // which is exactly what this call wants: the twin lives in the other world.
      reason:
        'the "does this address have a twin account in the OTHER world?" yes/no that labels the ' +
        'authenticator issuer (#2590) — it counts every other row holding the mailbox, on purpose ' +
        'across worlds, and returns a number, never a row',
    },
  ],
  [
    'src/lib/accountErasure.ts',
    {
      calls: 1,
      reason:
        'erasing one account may sweep the address-keyed EmailLog/NewsletterSend rows only when NO ' +
        'other account, in any world, still holds the address (#2590) — a count of the others by ' +
        'design, never a row and never an action on them',
    },
  ],
]);

// ── Reading the source ───────────────────────────────────────────────────────

/**
 * `source` with comments, string/template contents and regex bodies blanked and
 * every offset and newline kept. Strings never span a line here (a `'` in JSX
 * text like "Don't" must not swallow the rest of the file), templates do and
 * their `${…}` is skipped with proper nesting.
 */
export function maskCode(source) {
  const n = source.length;
  const out = source.split('');
  const blank = (from, to) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  // Index of the closing quote of the single-line string opening at `i`, or -1.
  const stringEnd = (i) => {
    const q = source[i];
    for (let j = i + 1; j < n; j++) {
      const c = source[j];
      if (c === '\\') j++;
      else if (c === q) return j;
      else if (c === '\n') return -1;
    }
    return -1;
  };
  // Index of the `}` closing the `${` whose `{` is at `open`.
  const interpolationEnd = (open) => {
    let depth = 0;
    for (let j = open; j < n; j++) {
      const c = source[j];
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) return j;
      } else if (c === '`') j = templateEnd(j);
      else if (c === "'" || c === '"') {
        const e = stringEnd(j);
        if (e >= 0) j = e;
      }
    }
    return n;
  };
  // Index of the closing backtick of the template opening at `i`.
  const templateEnd = (i) => {
    for (let j = i + 1; j < n; j++) {
      const c = source[j];
      if (c === '\\') j++;
      else if (c === '`') return j;
      else if (c === '$' && source[j + 1] === '{') j = interpolationEnd(j + 1);
    }
    return n;
  };
  // Does the `/` at `i` open a regex literal (as opposed to dividing)?
  const opensRegex = (i) => {
    let p = i - 1;
    while (p >= 0 && /\s/.test(out[p])) p--;
    if (p < 0) return true;
    if ('(,=:[!&|?{};+'.includes(out[p])) return true;
    return /(?:^|[^\w$.])(?:return|typeof|case|delete|void|throw|new|else|do|yield|await|in|of)$/.test(
      out.slice(Math.max(0, p - 8), p + 1).join(''),
    );
  };

  for (let i = 0; i < n; i++) {
    const c = source[i];
    const d = source[i + 1];
    if (c === '/' && d === '/') {
      let end = source.indexOf('\n', i);
      if (end < 0) end = n;
      blank(i, end);
      i = end - 1;
    } else if (c === '/' && d === '*') {
      let end = source.indexOf('*/', i + 2);
      end = end < 0 ? n : end + 2;
      blank(i, end);
      i = end - 1;
    } else if (c === "'" || c === '"') {
      const e = stringEnd(i);
      if (e >= 0) {
        blank(i + 1, e);
        i = e;
      }
    } else if (c === '`') {
      const e = templateEnd(i);
      blank(i + 1, e);
      i = e;
    } else if (c === '/' && opensRegex(i)) {
      let j = i + 1;
      let inClass = false;
      for (; j < n; j++) {
        const x = source[j];
        if (x === '\\') j++;
        else if (x === '\n') break; // unterminated: it was division after all
        else if (x === '[') inClass = true;
        else if (x === ']') inClass = false;
        else if (x === '/' && !inClass) break;
      }
      if (j < n && source[j] === '/') {
        blank(i + 1, j);
        i = j;
      }
    }
  }
  return out.join('');
}

const OPENERS = '([{';
const CLOSERS = ')]}';

/** Index of the bracket closing the one at `open`, or -1 if the source runs out first. */
function matchClose(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (OPENERS.includes(c)) depth++;
    else if (CLOSERS.includes(c)) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** [start, end) ranges of the comma-separated items strictly between `from` and `to`. */
function splitTop(code, from, to) {
  const ranges = [];
  let depth = 0;
  let start = from;
  for (let i = from; i < to; i++) {
    const c = code[i];
    if (OPENERS.includes(c)) depth++;
    else if (CLOSERS.includes(c)) depth--;
    else if (c === ',' && depth === 0) {
      ranges.push([start, i]);
      start = i + 1;
    }
  }
  ranges.push([start, to]);
  return ranges.filter(([s, e]) => code.slice(s, e).trim() !== '');
}

/** First non-blank offset in [start, end) and the end with trailing blanks trimmed. */
function trimRange(code, start, end) {
  let s = start;
  let e = end;
  while (s < e && /\s/.test(code[s])) s++;
  while (e > s && /\s/.test(code[e - 1])) e--;
  return [s, e];
}

/** The `{ key: value, … }` entries of the object literal opening at `open`. */
function objectEntries(ctx, open) {
  const close = matchClose(ctx.code, open);
  if (close < 0) return { entries: [], broken: true };
  const entries = [];
  for (const [rs, re] of splitTop(ctx.code, open + 1, close)) {
    const [s, e] = trimRange(ctx.code, rs, re);
    const text = ctx.code.slice(s, e);
    if (text.startsWith('...')) {
      const [vs, ve] = trimRange(ctx.code, s + 3, e);
      entries.push({ spread: true, key: null, vs, ve });
      continue;
    }
    let key = null;
    let m;
    if ((m = /^(['"])(\s*)\1/.exec(text))) {
      // A quoted key: its name is blanked in the mask, so read it from the source.
      key = ctx.source.slice(s + 1, s + 1 + m[2].length);
      const colon = text.indexOf(':', m[0].length);
      const [vs, ve] = colon < 0 ? [s, e] : trimRange(ctx.code, s + colon + 1, e);
      entries.push({ spread: false, key, vs, ve });
    } else if ((m = /^([A-Za-z_$][\w$]*)\s*(:|$)/.exec(text))) {
      key = m[1];
      // Shorthand `{ email }` — the value is the identifier itself.
      const [vs, ve] = m[2] === ':' ? trimRange(ctx.code, s + m[0].length, e) : [s, e];
      entries.push({ spread: false, key, vs, ve });
    } else {
      entries.push({ spread: false, key: null, vs: s, ve: e }); // computed key, method, …
    }
  }
  return { entries, broken: false };
}

const EMPTY = () => ({ email: false, pinned: false, opaque: false });

function merge(into, from, mode) {
  into.opaque = into.opaque || from.opaque;
  if (mode === 'and') {
    into.email = into.email || from.email;
    into.pinned = into.pinned || from.pinned;
  }
}

const MAX_DEPTH = 6;

/** Analyse the expression at [vs, ve) of the file as a Prisma `where`. */
function analyzeExpr(ctx, vs, ve, before, depth) {
  const text = ctx.code.slice(vs, ve);
  if (depth > MAX_DEPTH) return { ...EMPTY(), opaque: true };
  if (text.startsWith('{')) return analyzeObject(ctx, vs, before, depth + 1);
  if (text.startsWith('(')) {
    // `...(await tenantWhere(session))` — a parenthesised expression is the expression.
    const close = matchClose(ctx.code, vs);
    if (close === ve - 1) return analyzeExpr(ctx, ...trimRange(ctx.code, vs + 1, close), before, depth + 1);
  }
  const call = /^(?:await\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^()]*>)?\s*\(/.exec(text);
  if (call && PIN_FRAGMENT_CALLS.includes(call[1])) return { email: false, pinned: true, opaque: false };
  if (call && PIN_WRAPPER_CALLS.includes(call[1])) {
    // withinTenant({ email }, tenant): the first argument is the caller's own where.
    const open = ctx.code.indexOf('(', vs);
    const close = matchClose(ctx.code, open);
    const inner = { ...EMPTY(), pinned: true };
    if (close > 0) {
      const [first] = splitTop(ctx.code, open + 1, close);
      if (first) {
        const r = analyzeExpr(ctx, ...trimRange(ctx.code, first[0], first[1]), before, depth + 1);
        inner.email = r.email;
        inner.opaque = r.opaque;
      }
    }
    return inner;
  }
  if (/^[A-Za-z_$][\w$]*$/.test(text)) return resolveIdentifier(ctx, text, before, depth + 1);
  return { ...EMPTY(), opaque: true };
}

/** `const name = <expr>` — the nearest declaration of `name` before `before`. */
function resolveIdentifier(ctx, name, before, depth) {
  const decl = new RegExp(`\\b(?:const|let|var)\\s+${name.replace(/\$/g, '\\$')}\\b\\s*(?::[^=;]*?)?=(?![=>])`, 'g');
  let found = null;
  for (let m = decl.exec(ctx.code); m && m.index < before; m = decl.exec(ctx.code)) found = m;
  if (!found) return { ...EMPTY(), opaque: true }; // a parameter, an import, a closure we cannot see
  const start = found.index + found[0].length;
  // The initializer ends at the first `;` at depth 0 (or where its enclosing bracket closes).
  let depth0 = 0;
  let end = ctx.code.length;
  for (let i = start; i < ctx.code.length; i++) {
    const c = ctx.code[i];
    if (OPENERS.includes(c)) depth0++;
    else if (CLOSERS.includes(c)) {
      depth0--;
      if (depth0 < 0) {
        end = i;
        break;
      }
    } else if (c === ';' && depth0 === 0) {
      end = i;
      break;
    }
  }
  const [vs, ve] = trimRange(ctx.code, start, end);
  return analyzeExpr(ctx, vs, ve, found.index, depth);
}

/** A conjunction of members: `AND: [a, b]` / `AND: a` — every member applies. */
function members(ctx, vs, ve) {
  const text = ctx.code.slice(vs, ve);
  if (!text.startsWith('[')) return [[vs, ve]];
  const close = matchClose(ctx.code, vs);
  if (close < 0) return [];
  return splitTop(ctx.code, vs + 1, close).map(([s, e]) => trimRange(ctx.code, s, e));
}

/** Analyse the object literal opening at `open` as a Prisma `where`. */
function analyzeObject(ctx, open, before, depth) {
  const result = EMPTY();
  const { entries, broken } = objectEntries(ctx, open);
  if (broken) return { ...result, opaque: true };
  for (const entry of entries) {
    if (entry.spread) {
      merge(result, analyzeExpr(ctx, entry.vs, entry.ve, before, depth), 'and');
      continue;
    }
    const value = ctx.code.slice(entry.vs, entry.ve);
    switch (entry.key) {
      case 'email': {
        // `email: { contains: … }` is a search box, not an identity (see the header).
        if (value.startsWith('{')) {
          const inner = objectEntries(ctx, entry.vs).entries;
          if (inner.length > 0 && inner.every((x) => !x.spread && SEARCH_OPERATORS.has(x.key))) break;
        }
        result.email = true;
        break;
      }
      case 'AND': {
        for (const [s, e] of members(ctx, entry.vs, entry.ve)) merge(result, analyzeExpr(ctx, s, e, before, depth), 'and');
        break;
      }
      case 'OR': {
        const branches = members(ctx, entry.vs, entry.ve).map(([s, e]) => analyzeExpr(ctx, s, e, before, depth));
        if (branches.length === 0) break;
        result.opaque = result.opaque || branches.some((b) => b.opaque);
        result.email = result.email || branches.some((b) => b.email);
        result.pinned = result.pinned || branches.every((b) => b.pinned);
        break;
      }
      case 'NOT':
        // A negation narrows, so it never pulls the other world's row in — but it is
        // not a pin either, UNLESS it negates the world itself: the default world is
        // "everyone who is not in another vertical's organization", which is exactly
        // how worldUserWhere('INTERNSHIP') is written (and its plain-ESM mirrors in
        // the seeders, which cannot import TypeScript). `NOT: { orgId: x }` is not
        // that — it still admits every other organization, in both worlds.
        if (/\bvertical\b/.test(value)) result.pinned = true;
        break;
      default:
        if (PIN_KEYS.has(entry.key) && !isInertPin(entry.key, value)) result.pinned = true;
    }
  }
  return result;
}

/** `orgId: undefined` reads as "no filter" to Prisma; `id: { not: x }` matches almost everyone. */
function isInertPin(key, value) {
  if (/^undefined$/.test(value)) return true;
  if (key === 'id' && /^\{\s*(?:not|notIn)\b/.test(value)) return true;
  return false;
}

/**
 * Every `<x>.user.<method>(…)` call in one file, judged.
 * @returns {{ line: number, method: string, verdict: 'pinned'|'no-email'|'violation'|'unread'|'unbalanced', snippet: string }[]}
 */
export function analyzeSource(source) {
  const code = maskCode(source);
  const ctx = { source, code };
  const calls = [];
  const re = new RegExp(String.raw`\.\s*user\s*\??\.\s*(${METHODS.join('|')})\s*\(`, 'g');
  for (let m = re.exec(code); m; m = re.exec(code)) {
    const open = m.index + m[0].length - 1;
    const line = source.slice(0, m.index).split('\n').length;
    const snippet = `user.${m[1]}(${source.slice(open + 1, open + 61).replace(/\s+/g, ' ').trim()}…`;
    const close = matchClose(code, open);
    if (close < 0) {
      calls.push({ line, method: m[1], verdict: 'unbalanced', snippet });
      continue;
    }
    const [first] = splitTop(code, open + 1, close);
    if (!first) {
      calls.push({ line, method: m[1], verdict: 'no-email', snippet }); // e.g. count()
      continue;
    }
    const [fs, fe] = trimRange(code, first[0], first[1]);
    if (!code.slice(fs, fe).startsWith('{')) {
      calls.push({ line, method: m[1], verdict: 'unread', snippet }); // findMany(args)
      continue;
    }
    const { entries, broken } = objectEntries(ctx, fs);
    if (broken) {
      calls.push({ line, method: m[1], verdict: 'unbalanced', snippet });
      continue;
    }
    const where = entries.find((x) => !x.spread && x.key === 'where');
    if (!where) {
      const spread = entries.some((x) => x.spread);
      calls.push({ line, method: m[1], verdict: spread ? 'unread' : 'no-email', snippet });
      continue;
    }
    const r = analyzeExpr(ctx, where.vs, where.ve, m.index, 0);
    let verdict;
    if (r.email && !r.pinned) verdict = 'violation';
    else if (r.email) verdict = 'pinned';
    else verdict = r.opaque ? 'unread' : 'no-email';
    calls.push({ line, method: m[1], verdict, snippet });
  }
  return calls;
}

// ── The tree ────────────────────────────────────────────────────────────────

/** Source files under the roots, tests and dependencies excluded. */
export function sourceFiles(roots = ROOTS, list = readdirSync) {
  const out = [];
  const walk = (dir) => {
    for (const entry of list(dir, { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || SKIP_PATHS.some((p) => `${rel}/`.startsWith(p))) continue;
        walk(rel);
      } else if (SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name)) {
        out.push(rel);
      }
    }
  };
  for (const root of roots) {
    try {
      walk(root);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return out.sort();
}

/**
 * Judge a set of files.
 * @param {{ files: string[], read: (f: string) => string, exempt?: Map<string, {calls: number, reason: string}> }} input
 */
export function checkTree({ files, read, exempt = EXEMPT }) {
  const problems = [];
  const unread = [];
  let examined = 0;
  let pinned = 0;
  let excused = 0;
  const seen = new Set();

  for (const file of files) {
    seen.add(file);
    if (file === LOOKUP_API) continue;
    const calls = analyzeSource(read(file));
    examined += calls.length;
    const violations = calls.filter((c) => c.verdict === 'violation');
    pinned += calls.filter((c) => c.verdict === 'pinned').length;
    for (const c of calls.filter((x) => x.verdict === 'unread')) unread.push(`${file}:${c.line}`);
    for (const c of calls.filter((x) => x.verdict === 'unbalanced')) {
      problems.push(`${file}:${c.line}  ${c.snippet} — the call's brackets do not balance, so the guard cannot read it.`);
    }

    const excuse = exempt.get(file);
    if (excuse) {
      excused += Math.min(excuse.calls, violations.length);
      if (violations.length === excuse.calls) continue;
      if (violations.length < excuse.calls) {
        problems.push(
          `EXEMPT in scripts/check-user-email-lookups.mjs excuses ${excuse.calls} unpinned e-mail lookup(s) in ${file} ` +
            `("${excuse.reason.slice(0, 60)}…"), but only ${violations.length} remain — lower or delete the entry.`,
        );
        continue;
      }
      problems.push(
        `${file} holds ${violations.length} unpinned e-mail lookups but EXEMPT excuses ${excuse.calls}; ` +
          'the extra one(s) below are new:',
      );
    }
    for (const c of violations) problems.push(describe(file, c));
  }

  for (const [file, excuse] of exempt) {
    if (!seen.has(file)) {
      problems.push(
        `EXEMPT in scripts/check-user-email-lookups.mjs excuses ${file} ("${excuse.reason.slice(0, 60)}…"), ` +
          'which is not a file this check reads any more — delete the entry.',
      );
    }
  }
  for (const [file, excuse] of exempt) {
    if (!excuse.reason || excuse.reason.trim().length < 20 || !(excuse.calls > 0)) {
      problems.push(`EXEMPT entry for ${file} needs a positive \`calls\` and a real \`reason\` (why crossing worlds is the point).`);
    }
  }

  return { problems, examined, pinned, excused, unread };
}

function describe(file, call) {
  return (
    `${file}:${call.line}  ${call.snippet}\n` +
    '      looks a User up by e-mail without naming its world. Since #2590 one e-mail is one row PER WORLD,\n' +
    '      so this returns whichever row the database finds first. Use findUserInWorld(email, world, select)\n' +
    '      from @/lib/userWorld (world from the flow\'s org via worldOfOrg(), or from the host via\n' +
    '      worldForHeaders()); or add `orgId` / `...worldUserWhere(world)` / `id` to this where; or, if the\n' +
    '      call really is about every world, findUsersByEmail() with a comment saying why.'
  );
}

function main() {
  const explain = process.argv.includes('--explain');
  const files = sourceFiles();
  const read = (file) => readFileSync(file, 'utf8');
  if (explain) {
    for (const file of files) {
      if (file === LOOKUP_API) continue;
      for (const c of analyzeSource(read(file))) console.log(`${c.verdict.padEnd(10)} ${file}:${c.line}  ${c.snippet}`);
    }
    return;
  }
  const { problems, examined, pinned, excused, unread } = checkTree({ files, read });

  if (problems.length > 0) {
    console.error('user e-mail lookups FAILED — an e-mail is not an account any more, it is one account per world (#2590):\n');
    for (const problem of problems) console.error(`  • ${problem}\n`);
    console.error(
      `${LOOKUP_API} is the one place that turns an e-mail into a row; a deliberate exception goes in EXEMPT ` +
        'in scripts/check-user-email-lookups.mjs, with its reason.',
    );
    process.exit(1);
  }

  console.log(
    `user e-mail lookups OK — ${examined} User call(s) read across ${files.length} file(s); every one that filters ` +
      `on e-mail is pinned to a world or a row (${pinned}) or excused with a reason (${excused}). ` +
      `${unread.length} call(s) take a \`where\` this check cannot read (run with --explain).`,
  );
}

if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) main();
