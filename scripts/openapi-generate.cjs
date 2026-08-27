#!/usr/bin/env node
// Build-time OpenAPI 3.1 generator for the WHOLE internal API surface.
//
// Why this file exists, and why it is a build-time script rather than a request
// handler. The admin API explorer (/admin/api-explorer) needs a machine-readable
// description of every endpoint under src/app/api - ~190 route files. The
// obvious implementation, "walk src/app/api when the admin asks for the spec",
// cannot work here: the Docker runner stage copies only public/, .next/,
// node_modules/, package.json and prisma/ (see Dockerfile), so **src/ does not
// exist at runtime in production**. Any filesystem scan of the route tree has to
// happen while the app is being built.
//
// So this script is required from next.config.js - the same shape as
// scripts/release-derive.cjs, which derives the displayed version at config load
// and hands it to the bundle through `nextConfig.env`. The generated document is
// inlined into the server bundle there; src/app/api/admin/openapi/route.ts just
// parses that string and serves it behind an ADMIN check.
//
// Accuracy policy. This is a static analyser, not a type checker: it reads the
// route files with the TypeScript AST (`typescript` is a devDependency and is
// present in the builder stage, which runs `npm ci` WITH devDeps). Where it can
// be certain - the URL path, which HTTP verbs are exported, which guard the
// handler runs, a plain module-scope `z.object({...})` body - it says so. Where
// it cannot, it emits a free-form object and marks it `x-body-source: "unknown"`
// rather than inventing a confident-looking wrong schema. A wrong "no auth
// required" badge next to a real endpoint is the single most damaging thing this
// generator could produce, so guards are resolved through module-scope helpers
// (a handler whose only check is `await requireAdmin()` still classifies as
// admin-only) and the fallback classification is never "public" by omission -
// see classifyAuth().
//
// ONE INPUT PER OPERATION. Every fact this generator derives - the guard, the
// request body, the query keys, the response statuses, rate limiting, tenant
// scoping, step-up auth - is read from the SAME text: the handler body with its
// module-scope helpers textually inlined (`inlineHelpers`, the `resolved`
// variable in buildSpec). It used to be split - the auth classifier read the
// resolved text while the body/query/response probes read the raw handler - and
// that split is exactly why POST /api/admin/announcements shipped with no
// request body at all: it reads the payload through a module-scope readBody()
// helper, so the raw text contains no `request.json()`. Two inputs means two
// answers to "what does this handler do", and the document then contradicts
// itself. Switching every probe to the resolved text was checked
// operation-by-operation against the previous output: it added only facts that
// are really true of the endpoint (the two announcement bodies; `?from=`/`?to=`
// on /api/calendar-events and `?secret=` on /api/webhooks/jaas, both read in a
// helper; and the 400/403/404/409s that eleven handlers return by handing a
// helper's `{ status }` straight to NextResponse.json). Anything added here in
// future must be held to the same bar - see the note above responsesFor().
//
// Run:   node scripts/openapi-generate.cjs   (npm run gen:openapi)
// Check: node scripts/check-openapi.mjs      (npm run check:openapi)

const fs = require('node:fs');
const path = require('node:path');

const VERBS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const WRITE_VERBS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const API_DIR = path.join('src', 'app', 'api');
const OUT_FILE = path.join('src', 'generated', 'openapi.json');

// Endpoints where an idle click in a "Try it out" panel is irreversible or fans
// out real email. Keyed "METHOD /api/path"; scripts/check-openapi.mjs asserts
// every key still resolves to a real operation, so a route rename cannot
// silently drop the flag.
//
// What the explorer actually does with it: src/components/ApiExplorer.tsx
// collects x-destructive (plus x-try-it: false, plus EVERY DELETE regardless of
// annotation) into a matcher list and enforces it inside Swagger's
// `requestInterceptor` - a synchronous window.confirm naming the resolved method
// and URL, throwing to abort when declined, so the request is never sent. "Try
// it out" is NOT hidden and Execute is not removed; the click is confirmed.
const DESTRUCTIVE = new Set([
  'POST /api/admin/users/{id}/erase',
  'POST /api/admin/duplicates/merge',
  'POST /api/admin/candidates/bulk',
  'POST /api/admin/import',
  'POST /api/admin/impersonate',
  'DELETE /api/account',
  'POST /api/admin/email-test',
  'GET /api/cron',
  'POST /api/meetings/instant',
]);

// src/middleware.ts (matcher '/api/:path*') answers 403 to every write from a
// signed-in-but-unverified user, except this allowlist. Hand-copied from
// isAllowlisted() there; scripts/check-openapi.mjs asserts every entry below
// still appears in that file.
const VERIFY_EXEMPT = [
  '/api/auth/',
  '/api/register',
  '/api/impersonate/stop',
  '/api/rsvp',
  '/api/apply',
  '/api/profile-view',
  '/api/inbound-email',
  // The unsubscribe surface (#1444). Two entries, mirroring the two clauses in
  // src/middleware.ts exactly: an exact match for the bare path and a prefix for
  // everything under it. A single prefix entry would also exempt a future
  // sibling like /api/unsubscribe-all, which is the mistake the middleware side
  // was narrowed to avoid — and this list is checked against that one, so the
  // two have to be wrong or right together.
  '/api/unsubscribe',
  '/api/unsubscribe/',
];

/**
 * Match the middleware's own semantics, which are EXACT equality for every
 * entry except the '/api/auth/' prefix (`pathname.startsWith('/api/auth/')`).
 *
 * Prefix-matching all of them was wrong in one place, and wrong in the
 * dangerous direction: POST /api/inbound-email/poll is not
 * `pathname === '/api/inbound-email'`, so an unverified signed-in caller really
 * does get 403 there - and the generated document was dropping both the 403 and
 * the middleware note for it.
 */
const verifyExempt = (urlPath) => VERIFY_EXEMPT.some((e) => (e.endsWith('/') ? urlPath.startsWith(e) : urlPath === e));

// ---------------------------------------------------------------------------
// Path derivation
// ---------------------------------------------------------------------------

/**
 * Turn a directory path relative to src/app/api into an API URL path plus the
 * dynamic parameters it declares.
 *
 * Route groups `(name)` are stripped (there are none today; one future
 * `(admin)/` group would otherwise silently shift ~90 paths). `[id]` becomes
 * `{id}`; `[...nextauth]` becomes `{nextauth}` and marks the operation as a
 * catch-all. A segment containing a dot but no bracket is LITERAL - the public
 * spec really is served from a directory called `openapi.json`, and the URL
 * keeps the dot. Bracket detection therefore has to run before dot detection.
 */
function urlPathFor(relDir) {
  const params = [];
  let catchAll = false;
  const segments = [];
  for (const raw of String(relDir).split(path.sep)) {
    if (!raw || raw === '.') continue;
    if (raw.startsWith('(') && raw.endsWith(')')) continue; // route group
    if (raw.startsWith('[')) {
      const inner = raw.replace(/^\[+/, '').replace(/\]+$/, '');
      const name = inner.replace(/^\.\.\./, '');
      if (inner.startsWith('...')) catchAll = true;
      params.push(name);
      segments.push(`{${name}}`);
    } else {
      segments.push(raw);
    }
  }
  return { urlPath: `/api${segments.length ? `/${segments.join('/')}` : ''}`, params, catchAll };
}

/** Every src/app/api/route.ts descendant, sorted, relative to the api dir. */
function routeFiles(apiDir) {
  const found = [];
  const walk = (dir, rel) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs, path.join(rel, entry.name));
      // Only files named exactly route.ts. Collocated helpers (none today) and
      // route.js/.tsx variants are skipped rather than guessed at.
      else if (entry.name === 'route.ts') found.push(path.join(rel, entry.name));
    }
  };
  walk(apiDir, '');
  return found;
}

// ---------------------------------------------------------------------------
// Comment extraction + sanitising
// ---------------------------------------------------------------------------

// The route comments are internal engineering notes, not API docs. These
// patterns mark a line as not-for-display: an env-var name ending in
// SECRET/TOKEN/KEY/PASSWORD (bare ALL-CAPS is far too broad - role and enum
// names like MENTEE or IN_PROGRESS appear in comments constantly and are
// legitimate documentation), any URL, any internal host, and any process.env
// reference. Publishing an operator runbook line that puts a secret in a query
// string into a "Try it out" UI invites someone to paste the real one into a
// browser address bar.
const REDACT_LINE = [
  /\b[A-Z][A-Z0-9_]{3,}(SECRET|TOKEN|KEY|PASSWORD)\b/,
  /https?:\/\//,
  /localhost|127\.0\.0\.1|\.ersah\.in/,
  /process\.env\./,
];

// Explicit opt-out marker. Put `@openapi-ignore` anywhere in a route handler's
// leading comment and NONE of that comment is published - the operation keeps
// its derived summary (`GET /api/...`) and an empty description.
//
// Why a marker and not another REDACT_LINE pattern. The line-level patterns
// above catch shapes that are always unpublishable (a credential env var, a
// URL, an internal host). What triggered this is different: GET
// /api/availability's comment explains the tenant-isolation MECHANISM - it names
// the model allowlist and states which models fall outside the central
// guarantee. Nothing in that text looks like a secret, so no regex would find
// it, and since x-source names the exact file for every operation, publishing it
// hands a reader a starting point for hunting isolation bugs. Broadening the
// regex to the identifier of the week is whack-a-mole; letting the author of the
// comment declare "this one is internal" is the right shape.
//
// The marker is spelled exactly `@openapi-ignore`, and route files depend on
// that spelling - do not "improve" it.
const IGNORE_MARKER = '@openapi-ignore';

/**
 * A comment block -> displayable prose, or '' when it opts out.
 *
 * The marker check covers everything the caller handed in. leadingComment()
 * passes the whole contiguous comment block above the declaration, so marking
 * any one line of it opts the block out - which is what you want, since the
 * lines around a mechanism description are usually about the same mechanism.
 */
function sanitizeComment(text) {
  if (String(text).includes(IGNORE_MARKER)) return '';
  const kept = String(text)
    .split('\n')
    // Strip the comment furniture: `/**`, a bare `/*` (no route uses single-star
    // block comments today - closing it anyway, it is one `?`), `//`, a leading
    // `*` continuation, and `*/` at either end of the line.
    .map((l) => l.replace(/^\s*(\/\*\*?|\*\/|\/\/|\*)\s?/, '').replace(/\s*\*\/\s*$/, '').trimEnd())
    .filter((l) => !REDACT_LINE.some((re) => re.test(l)));
  return kept.join(' ').replace(/\s+/g, ' ').trim();
}

/** The contiguous comment block immediately above a node, sanitised. */
function leadingComment(ts, sourceFile, node) {
  const full = sourceFile.getFullText();
  const ranges = ts.getLeadingCommentRanges(full, node.getFullStart()) || [];
  if (!ranges.length) return '';
  // Only the block that touches the declaration: walk back while each comment is
  // separated from the next by at most one newline.
  const kept = [ranges[ranges.length - 1]];
  for (let i = ranges.length - 2; i >= 0; i -= 1) {
    const between = full.slice(ranges[i].end, kept[0].pos);
    if ((between.match(/\n/g) || []).length > 1) break;
    kept.unshift(ranges[i]);
  }
  return sanitizeComment(kept.map((r) => full.slice(r.pos, r.end)).join('\n'));
}

const clip = (s, n) => (s.length <= n ? s : `${s.slice(0, n - 1).replace(/[\s,;:-]+$/, '')}...`);

/** summary = first sentence with the leading verb stripped; description = rest. */
function summaryAndDescription(comment, method, urlPath) {
  if (!comment) return { summary: `${method} ${urlPath}`, description: '' };
  // 199 of the 210 commented handlers open with their own HTTP verb, usually
  // followed by an em dash ("POST - merge a duplicate candidate..."). Strip both
  // or the summary reads "- merge a duplicate candidate...".
  const body = comment
    .replace(new RegExp(`^(${VERBS.join('|')})\\b`), '')
    .replace(/^[\s\u2013\u2014:-]+/, '');
  const m = body.match(/^(.+?[.!?])(\s|$)/);
  const first = (m ? m[1] : body).trim();
  return { summary: clip(first || `${method} ${urlPath}`, 140), description: clip(body, 1400) };
}

// ---------------------------------------------------------------------------
// Handler discovery
// ---------------------------------------------------------------------------

/**
 * Every exported HTTP handler in a route file, in every syntactic form that
 * occurs in this repo (and one that does not yet, so the next PR to use it does
 * not silently vanish from the spec):
 *   export async function GET(...)     299 handlers
 *   export function GET()              1 - the public spec route. Do NOT gate
 *                                        on `async` or it drops out.
 *   export { handler as GET, ... }     2 - the NextAuth catch-all
 *   export const GET = ...             0, supported anyway
 * Route-segment config exports (`export const dynamic = 'force-dynamic'`) are
 * filtered by NAME, not by "is exported".
 */
function collectModule(ts, sourceFile) {
  const handlers = [];
  const symbols = new Map(); // module-scope name -> source text (guards, zod schemas)
  const nodes = new Map(); // module-scope name -> initializer node
  const isExported = (n) => (ts.getCombinedModifierFlags(n) & ts.ModifierFlags.Export) !== 0;

  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      const name = stmt.name.text;
      if (isExported(stmt) && VERBS.includes(name)) {
        handlers.push({ method: name, node: stmt, body: stmt.body ? stmt.body.getText(sourceFile) : '', form: 'function' });
      } else {
        symbols.set(name, stmt.getText(sourceFile));
      }
      continue;
    }
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        const name = decl.name.text;
        if (isExported(stmt) && VERBS.includes(name)) {
          handlers.push({ method: name, node: stmt, body: decl.initializer ? decl.initializer.getText(sourceFile) : '', form: 'const' });
        } else if (decl.initializer) {
          symbols.set(name, decl.initializer.getText(sourceFile));
          nodes.set(name, decl.initializer);
        }
      }
      continue;
    }
    // export { handler as GET, handler as POST }
    if (ts.isExportDeclaration(stmt) && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      for (const el of stmt.exportClause.elements) {
        // el.name is the EXPORTED name (GET), el.propertyName the local one
        // (handler). Reading these the wrong way round produces two operations
        // both called "handler".
        if (!VERBS.includes(el.name.text)) continue;
        const local = el.propertyName ? el.propertyName.text : el.name.text;
        handlers.push({ method: el.name.text, node: stmt, body: symbols.get(local) || sourceFile.getFullText(), form: 'reexport' });
      }
    }
  }
  return { handlers, symbols, nodes };
}

/**
 * Handler text with module-scope helpers textually inlined, so a guard that
 * lives outside the handler still gets seen. Without this, four endpoints -
 * admin/document-requirements GET (adminSession), inbound-email POST and
 * webhooks/jaas POST (secretOk), health GET (maySeeDetail) - classify as
 * "public", which is exactly the output that must never reach an admin UI.
 * Two rounds is more than this corpus needs.
 */
function inlineHelpers(body, symbols, rounds = 2) {
  let text = body;
  for (let i = 0; i < rounds; i += 1) {
    let grew = '';
    for (const [name, src] of symbols) {
      if (typeof src !== 'string') continue;
      if (new RegExp(`\\b${name}\\s*\\(`).test(text) && !text.includes(src)) grew += `\n${src}`;
    }
    if (!grew) break;
    text += grew;
  }
  return text;
}

// ---------------------------------------------------------------------------
// Authorisation classification
// ---------------------------------------------------------------------------

const ROLE_LITERALS = ['ADMIN', 'MENTOR', 'MENTEE', 'COMPANY', 'SOURCE'];

/**
 * Every `if (...)` in a chunk of handler text, paired with whether its FIRST
 * statement is a 401/403 rejection.
 *
 * Polarity is the whole point of this. `role !== 'ADMIN'` guarding a 401 means
 * "ADMIN required"; `role === 'MENTEE'` guarding a 401 means "MENTEE rejected",
 * which is the opposite. Reading both as "the roles this endpoint is for"
 * printed `roles: MENTEE` next to GET /api/projects/{id}/members, whose only
 * role rule is that a MENTEE may NOT call it.
 *
 * Only the immediately-following statement counts. Widening it to "a 403 appears
 * somewhere in the block" misreads business rules as guards: the same file's
 * POST has `if (session.user.role === 'MENTOR' && role === 'MENTEE') { ...load
 * the relation...; if (!relation) return 403 }`, where MENTOR is allowed, not
 * rejected.
 */
function guardConditions(text) {
  // Hand-rolled paren matching over source TEXT, in a script that has already
  // parsed the file with the TypeScript AST - which looks like an oversight and
  // is not. The input here is not a source file: it is inlineHelpers() output,
  // the handler body CONCATENATED with the source text of every module-scope
  // helper it calls. That string is not a valid program (it is a block statement
  // followed by loose declarations pulled from elsewhere in the file), so there
  // is no node to walk. Re-parsing it would mean re-implementing the inlining as
  // an AST transform, which is a much larger change than the two functions that
  // read this text need. topLevelConjuncts() below is text-based for the same
  // reason.
  const out = [];
  const re = /\bif\s*\(/g;
  let m;
  while ((m = re.exec(text))) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < text.length && depth > 0; i += 1) {
      if (text[i] === '(') depth += 1;
      else if (text[i] === ')') depth -= 1;
    }
    if (depth !== 0) continue;
    const cond = text.slice(m.index + m[0].length, i - 1);
    const after = text.slice(i).replace(/^\s*\{?\s*/, '').slice(0, 200);
    // A rejection is either returned straight from the handler, or handed back
    // through a gate helper that wraps it - `return { error: NextResponse.json(
    // { error: 'Forbidden' }, { status: 403 }) }` (src/app/api/requisitions,
    // mentor-applications, meeting-series). Missing the wrapped form left all
    // four requisition operations at a vague "requires a session" when they are
    // really ADMIN-or-COMPANY.
    const rejects =
      /^return\s+(?:NextResponse\s*\.\s*json\s*\(|\{\s*error\s*:\s*NextResponse\s*\.\s*json\s*\()/.test(after) &&
      /status:\s*40[13]|'(Unauthorized|Forbidden)'/.test(after);
    out.push({ cond, rejects });
  }
  return out;
}

/**
 * Split a condition into its top-level `&&` conjuncts, ignoring `&&` nested
 * inside parentheses, brackets, braces or a string literal.
 *
 * This is text, not AST, for the same reason guardConditions() is - see the note
 * there.
 */
function topLevelConjuncts(cond) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < cond.length; i += 1) {
    const ch = cond[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (depth === 0 && ch === '&' && cond[i + 1] === '&') {
      parts.push(cond.slice(start, i));
      i += 1;
      start = i + 1;
    }
  }
  parts.push(cond.slice(start));
  return parts;
}

/**
 * Classify one handler. Returns
 * { classes, roles, denied, escape, notes, approximate }.
 *
 * `role === 'X'` is NOT a session-role check 87 times out of 323 in this repo -
 * the rest are Prisma `where` clauses and ProjectMember roles (there is no
 * OWNER session role). So comparisons only count when they are anchored on
 * session.user.role or on a local identifier initialised from it: six handlers
 * alias it first (`const role = session.user.role`, `const { id, role } =
 * session.user`), and anchoring strictly on the member expression under-detects
 * those.
 *
 * Where a guard cannot be followed - it lives in a helper that takes
 * `session.user` as a parameter, or the allowed roles come out of a lookup table
 * (ALLOWED_ROLES[session.user.role] in the invite route) - the result is
 * deliberately the WEAKER statement, "requires a session", rather than a
 * confident role list. Under-stating access is recoverable; over-stating it is
 * how an explorer starts lying about who can call what.
 */
function classifyAuth(text, ctx = {}) {
  const params = ctx.params || [];
  const classes = [];
  const notes = [];

  const hasSession = /getServerSession\s*\(/.test(text);

  // Identifiers that hold the session role.
  const anchors = ['session\\s*[?.]*\\s*\\.\\s*user\\s*[?.]*\\s*\\.\\s*role'];
  for (const m of text.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*session\s*[?.]*\s*\.\s*user\s*[?.]*\s*\.\s*role/g)) {
    anchors.push(`\\b${m[1]}\\b`);
  }
  for (const m of text.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*session\s*[?.]*\s*\.\s*user\b/g)) {
    if (/\brole\b/.test(m[1])) anchors.push('\\brole\\b');
  }
  const anchorAlt = anchors.join('|');
  const roleAlt = ROLE_LITERALS.join('|');
  const NEGATIVE = new RegExp(`(?:${anchorAlt})\\s*!==\\s*'(${roleAlt})'|'(${roleAlt})'\\s*!==\\s*(?:${anchorAlt})`, 'g');
  const POSITIVE = new RegExp(`(?:${anchorAlt})\\s*===\\s*'(${roleAlt})'|'(${roleAlt})'\\s*===\\s*(?:${anchorAlt})`, 'g');
  const INCLUDES = new RegExp(`(!?)\\s*\\[([^\\]]*)\\]\\s*\\.\\s*includes\\s*\\(\\s*(?:${anchorAlt})\\s*\\)`, 'g');
  const collect = (chunk, re, group = 1) => {
    const found = [];
    for (const m of chunk.matchAll(re)) found.push(m[group] || m[group + 1]);
    return found.filter(Boolean);
  };
  const listRoles = (inner) => [...inner.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]).filter((r) => ROLE_LITERALS.includes(r));

  const allow = new Set();
  const deny = new Set();
  // Roles that BYPASS a non-role rule rather than being required by it - see
  // `mixed` below.
  const escape = new Set();
  let approximate = false;

  // Everything in a reject condition that is not itself an access rule about
  // the session role: a role comparison, a role-list `.includes()`, and "there
  // is no session at all".
  //
  // NO_SESSION is pinned to exactly `!session`, `!session.user` and
  // `!session?.user`. It is tempting to write `!\s*session[?.\w]*` - do not:
  // that also swallows `!session.user.companyId`, which is a real extra
  // requirement, and GET /api/company/analytics would then report COMPANY as
  // simply allowed when a COMPANY user with no linked company is refused.
  const ROLE_CMP = new RegExp(`(?:${anchorAlt})\\s*[!=]==\\s*'(?:${roleAlt})'|'(?:${roleAlt})'\\s*[!=]==\\s*(?:${anchorAlt})`, 'g');
  const ROLE_INCLUDES = new RegExp(INCLUDES.source, 'g');
  const NO_SESSION = /!\s*session(?:\s*\??\.\s*user)?(?!\s*[?.\w])/g;

  /**
   * Is there anything left in this fragment once every role test and the
   * "no session at all" test are deleted from it?
   *
   * Paren-aware callers use this per top-level `&&` conjunct, and that is the
   * whole point. The previous implementation deleted the role comparisons from
   * the WHOLE condition text and then tested the residue for `&&`: deleting both
   * sides of `A && B` leaves a bare `&&`, so a condition made ENTIRELY of role
   * comparisons ("not ADMIN and not COMPANY -> reject") was misread as
   * containing a non-role term. That is where 31 of the 49 role-session
   * operations got their x-auth-approximate from.
   */
  const hasNonRoleTerm = (part) =>
    part
      .replace(ROLE_CMP, '')
      .replace(ROLE_INCLUDES, '')
      .replace(NO_SESSION, '')
      .replace(/[\s()!|&,]/g, '') !== '';

  const guards = guardConditions(text);

  // Does any REJECTING guard actually test the session? `getServerSession()`
  // appearing in the text is not the same question.
  //
  // GET /api/health is the case that forced this. It calls getServerSession
  // inside a maySeeDetail() helper, and its only use of the result is
  // `if (!(await maySeeDetail(request))) return <the short answer>` - which is
  // not a rejection, it is a narrower success body. The endpoint answers 200 to
  // an anonymous caller always, and with HEALTH_TOKEN unset it hands everyone
  // the full detail. hasSession alone therefore classified it "requires any
  // signed-in session" and declared a 401 it cannot emit. In a document sold as
  // the complete internal inventory the reader's question is "what is reachable
  // anonymously", and this was the one endpoint that hid the answer - it also
  // contradicted the route's own comment, "Liveness stays public - a monitor
  // cannot log in".
  //
  // Session-derived aliases count too: a guard spelled `if (!user)` after
  // `const user = session.user` is a session requirement.
  const sessionRefs = ['\\bsession\\b'];
  for (const m of text.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?[^;\n]*\bsession\b/g)) {
    sessionRefs.push(`\\b${m[1]}\\b`);
  }
  for (const m of text.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*session\b/g)) {
    for (const part of m[1].split(',')) {
      const name = part.split(':').pop().trim().replace(/^\.\.\./, '');
      if (/^[A-Za-z_$][\w$]*$/.test(name)) sessionRefs.push(`\\b${name}\\b`);
    }
  }
  const SESSION_REF = new RegExp(sessionRefs.join('|'));
  const sessionRequired = guards.some((g) => g.rejects && SESSION_REF.test(g.cond));

  for (const guard of guards) {
    if (!guard.rejects) continue;
    const negative = collect(guard.cond, NEGATIVE);
    const positive = collect(guard.cond, POSITIVE);
    const includes = [...guard.cond.matchAll(INCLUDES)];
    const conjuncts = topLevelConjuncts(guard.cond);
    const mixed = conjuncts.some(hasNonRoleTerm);
    // "not one of these -> reject" is USUALLY the one unambiguous shape: these
    // are exactly the roles the endpoint is for. The exception turns on the
    // operator, so work per top-level `&&` conjunct.
    //
    // `reject if C` means "allowed iff !C", so De Morgan decides it:
    //   reject if (!session || role !== 'ADMIN' || impersonatorId)
    //     -> allowed iff session AND role === 'ADMIN' AND !impersonatorId
    //        ADMIN is REQUIRED (POST /api/admin/impersonate).
    //   reject if (userId !== session.user.id && role !== 'ADMIN')
    //     -> allowed iff userId === session.user.id OR role === 'ADMIN'
    //        ADMIN is an ESCAPE HATCH over an ownership rule, not a requirement
    //        (DELETE /api/avatar/{userId}, whose own summary reads "remove own
    //        avatar (or admin removes anyone's)" - the generator used to print
    //        "Requires a signed-in ADMIN session" directly above it).
    //   reject if (!session || (role !== 'COMPANY' && role !== 'ADMIN'))
    //     -> allowed iff session AND (COMPANY OR ADMIN); the inner `&&` is one
    //        top-level conjunct made only of role tests, so both are required.
    // A negative role comparison therefore only stops being a requirement when
    // it shares the top level of `&&` with a conjunct that tests something other
    // than the role or the presence of a session.
    for (const [idx, part] of conjuncts.entries()) {
      const negHere = collect(part, NEGATIVE);
      if (!negHere.length) continue;
      const escapes = conjuncts.some((other, i) => i !== idx && hasNonRoleTerm(other));
      for (const r of negHere) (escapes ? escape : allow).add(r);
    }
    for (const inc of includes) {
      const roles = listRoles(inc[2]);
      for (const r of roles) (inc[1] === '!' ? allow : deny).add(r);
    }
    // "is this role -> reject" denies the role, but only when the role IS the
    // whole condition: `role === 'COMPANY' && !session.user.companyId` rejects a
    // COMPANY session that is missing a company, and COMPANY is very much
    // allowed (GET /api/offers).
    if (positive.length) {
      if (mixed) approximate = true;
      else for (const r of positive) deny.add(r);
    }
    // A negated role LIST in a mixed conjunction is the same shape as `negative`
    // above and would belong in `escape` too; the flag is the conservative
    // stand-in because no route in this repo currently writes one, so routing it
    // has never been exercised against real output.
    if (includes.length && mixed) approximate = true;
  }
  // Positive `role === 'X'` comparisons OUTSIDE a rejecting guard are ignored
  // on purpose. They are usually branch logic, not access control, and reading
  // them as an allow-list narrowed DELETE /api/account - self-service deletion
  // any signed-in user may call - to "ADMIN only", because its last-admin check
  // happens to be spelled `if (session.user.role === 'ADMIN')`. The cost is that
  // a guard hidden in an unnamed boolean helper reports only "requires a
  // session"; that under-states access, which is the safe direction to be wrong
  // in.

  // A helper named requireAdmin*/adminSession is decisive even where its body
  // was not resolvable (an imported guard, a re-export).
  if (/\b(?:requireAdmin[A-Za-z]*|adminSession)\s*\(/.test(text)) allow.add('ADMIN');

  for (const r of deny) {
    allow.delete(r);
    escape.delete(r);
  }
  // A role that is genuinely required is not also an escape hatch.
  for (const r of allow) escape.delete(r);
  const roles = [...allow].sort();
  const denied = [...deny].sort();
  const escapes = [...escape].sort();

  if (roles.length) classes.push(roles.length === 1 && roles[0] === 'ADMIN' ? 'admin-session' : 'role-session');
  else if (hasSession && sessionRequired) classes.push('any-session');
  else if (hasSession) {
    notes.push(
      'The session is read when one is present, but nothing here requires it: no guard rejects a caller merely for being anonymous. Any remaining restriction is per-record - see the route file named in x-source.',
    );
  }
  if (denied.length && hasSession) notes.push(`Rejects these roles outright: ${denied.join(', ')}.`);

  if (/authenticateApiKey\s*\(/.test(text)) classes.push('api-key');

  // Shared secret in a request header, compared in constant time.
  //
  // Claiming "requires this header" is a claim that a caller without it is
  // REJECTED, so it is gated on the handler having a rejecting guard at all.
  // GET /api/health reads x-health-token in constant time and rejects nobody:
  // the token (like an ADMIN session) only decides how much detail comes back,
  // and the endpoint answers 200 to an anonymous caller either way. Every route
  // that really is secret-gated - inbound-email, inbound-email/poll,
  // webhooks/jaas, cron/start - answers 401 from an `if`, so this costs them
  // nothing. Deliberately NOT applied to the token classes below: an endpoint
  // where an unguessable token is looked up straight in a `where` clause
  // legitimately answers 404 rather than 401 for a bad token, and calling those
  // "public" would be a lie in the dangerous direction.
  const headers = [...text.matchAll(/headers\s*\.\s*get\s*\(\s*'(x-[\w-]+)'/g)].map((m) => m[1]);
  const secretHeaders = headers.filter((h) => /(secret|token)/.test(h));
  if (secretHeaders.length && /timingSafeEqual|expected/.test(text)) {
    if (guards.some((g) => g.rejects)) {
      classes.push(secretHeaders.includes('x-cron-secret') ? 'cron-secret' : 'shared-secret');
      notes.push(`Requires the \`${secretHeaders[0]}\` request header.`);
    } else {
      notes.push(`Compares the \`${secretHeaders[0]}\` request header when one is sent, but no guard rejects a caller that omits it.`);
    }
  }

  // A signed, self-describing token in the body/query (consent renewal, email
  // actions, one-click leave links).
  if (/\bverify[A-Za-z]*Token\s*\(/.test(text)) {
    classes.push('signed-token');
    notes.push('Authenticated by a signed token from an emailed link, not by a session.');
  }

  // The credential is an unguessable value looked up straight in a token
  // column - no session, and no verify*Token() call to key off. "Public" would
  // be the wrong label for these.
  if (/where:\s*\{\s*(?:token|rsvpToken|icsFeedToken)\b/.test(text)) {
    classes.push('opaque-token');
    notes.push('The link itself is the credential: an unguessable token is looked up directly.');
  }
  if (params.includes('token')) {
    classes.push('path-token');
    notes.push('The unguessable token in the URL is the credential.');
  }
  // The NextAuth catch-all is its own credential surface (sign-in, callbacks,
  // csrf) - calling it "public" invites someone to click GET /api/auth/signout
  // in a Try-it panel and end their own session.
  if (/\bNextAuth\s*\(/.test(text)) {
    classes.push('nextauth');
    notes.push('Handled by NextAuth itself: this is the sign-in / sign-out / session / csrf / callback surface.');
  }
  if (/node-saml|validatePostResponse/.test(text)) {
    classes.push('saml-assertion');
    notes.push('Authenticated by the identity provider signature on the SAML assertion.');
  }

  if (!classes.length) classes.push('public');
  if (escapes.length && hasSession) {
    // Deliberately NOT phrased as "checks on top of the role check": the role is
    // the way AROUND the other check, not an extra hurdle in front of it.
    const list = escapes.join(' or ');
    notes.push(
      `Access is decided by a non-role condition - typically ownership of the record being addressed - which a session with the ${list} role may bypass. ${list} is an escape hatch here, not a requirement: any signed-in caller that satisfies the condition is allowed.`,
    );
  }
  if (approximate) notes.push('Further per-record checks (ownership, tenancy, step-up auth) apply on top of the role check.');

  // Deterministic, most-restrictive-first ordering.
  const ORDER = [
    'admin-session',
    'role-session',
    'any-session',
    'api-key',
    'cron-secret',
    'shared-secret',
    'signed-token',
    'opaque-token',
    'path-token',
    'saml-assertion',
    'nextauth',
    'public',
  ];
  const unique = [...new Set(classes)].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  return { classes: unique, roles, denied, escapes, notes, approximate };
}

const AUTH_PROSE = {
  'admin-session': 'Requires a signed-in ADMIN session.',
  'role-session': 'Requires a signed-in session with one of these roles: ',
  'any-session': 'Requires any signed-in session.',
  'api-key': 'Accepts an admin-issued API key as a Bearer token.',
  'cron-secret': 'Requires the scheduler shared-secret header.',
  'shared-secret': 'Requires a shared-secret header configured on the server.',
  'signed-token': 'Authenticated by a signed token from an emailed link.',
  'opaque-token': 'Authenticated by an unguessable token; no session needed.',
  'path-token': 'Authenticated by the unguessable token in the URL.',
  'saml-assertion': 'Authenticated by a SAML assertion from the identity provider.',
  nextauth: 'Handled by NextAuth (sign-in, sign-out, session, csrf, callbacks).',
  public: 'No credential required.',
};

// ---------------------------------------------------------------------------
// zod request bodies
// ---------------------------------------------------------------------------

const ZOD_PRIMITIVES = {
  string: { type: 'string' },
  number: { type: 'number' },
  boolean: { type: 'boolean' },
  date: { type: 'string', format: 'date-time' },
  bigint: { type: 'integer' },
  unknown: {},
  any: {},
};

/** The nearest CallExpression whose callee is `.<name>`. */
function findCall(ts, node, name) {
  let found = null;
  const visit = (n) => {
    if (found) return;
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === name) {
      found = n;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

function firstCallArgObject(ts, node, name) {
  const call = findCall(ts, node, name);
  if (!call) return null;
  return call.arguments.find((a) => ts.isObjectLiteralExpression(a)) || null;
}

/** `z.<name>` at the head of an expression's text. */
function headCall(text) {
  const m = text.match(/^\s*z\s*\.\s*([A-Za-z]+)/);
  return m ? m[1] : null;
}

/** Depth-limited zod expression -> JSON Schema. Returns null when unsure. */
function zodToSchema(ts, node, sourceFile, nodes, depth = 0) {
  if (!node || depth > 3) return null;
  const text = node.getText(sourceFile);
  let head = headCall(text);

  if (head === 'coerce') {
    const m = text.match(/^\s*z\s*\.\s*coerce\s*\.\s*([A-Za-z]+)/);
    head = m ? m[1] : null;
  }

  // Composition this analyser will not guess at: applying .partial()/.extend()/
  // .merge()/.omit()/.pick() to another schema. Checked BEFORE the reference
  // resolution below, because `recurrenceSchema.partial().extend({ id })`
  // otherwise resolves to recurrenceSchema and confidently emits its fields as
  // required while dropping `id` - a wrong body that looks derived.
  if (/\.(?:partial|extend|merge|omit|pick)\s*\(/.test(text)) return null;

  if (!head) {
    // A local schema reference (labelsSchema, roleSchema, stage, localeText...).
    const ref = text.match(/^\s*([A-Za-z_$][\w$]*)\s*$/);
    if (ref && nodes.has(ref[1])) return zodToSchema(ts, nodes.get(ref[1]), sourceFile, nodes, depth + 1);
    // `someSchema.optional()` / `passwordSchema.optional()` - resolve the base.
    const chained = text.match(/^\s*([A-Za-z_$][\w$]*)\s*\./);
    if (chained && nodes.has(chained[1])) return zodToSchema(ts, nodes.get(chained[1]), sourceFile, nodes, depth + 1);
    return null;
  }

  if (ZOD_PRIMITIVES[head]) {
    const schema = { ...ZOD_PRIMITIVES[head] };
    if (head === 'string') {
      if (/\.email\(/.test(text)) schema.format = 'email';
      else if (/\.url\(/.test(text)) schema.format = 'uri';
      const max = text.match(/\.max\(\s*(\d+)/);
      if (max) schema.maxLength = Number(max[1]);
    }
    return schema;
  }
  if (head === 'enum' || head === 'nativeEnum') {
    const call = findCall(ts, node, head);
    const arr = call && call.arguments[0];
    if (arr && ts.isArrayLiteralExpression(arr)) {
      const values = arr.elements.filter((e) => ts.isStringLiteral(e)).map((e) => e.text);
      if (values.length === arr.elements.length && values.length) return { type: 'string', enum: values };
    }
    return { type: 'string' };
  }
  if (head === 'literal') {
    const call = findCall(ts, node, 'literal');
    const arg = call && call.arguments[0];
    if (arg && ts.isStringLiteral(arg)) return { type: 'string', const: arg.text };
    return {};
  }
  if (head === 'record') {
    // z.record(z.string(), z.object({...})) - the VALUE schema is the last
    // argument; z.record(z.object({...})) has only one.
    const call = findCall(ts, node, 'record');
    const arg = call && call.arguments[call.arguments.length - 1];
    const value = arg ? zodToSchema(ts, arg, sourceFile, nodes, depth + 1) : null;
    return { type: 'object', additionalProperties: value || true };
  }
  if (head === 'array') {
    const call = findCall(ts, node, 'array');
    const arg = call && call.arguments[0];
    const items = arg ? zodToSchema(ts, arg, sourceFile, nodes, depth + 1) : null;
    return { type: 'array', items: items || {} };
  }
  if (head === 'object') {
    const lit = firstCallArgObject(ts, node, 'object');
    const schema = lit ? objectSchema(ts, lit, sourceFile, nodes, depth + 1) : null;
    // .strict() -> no unknown keys accepted.
    if (schema && /\.strict\(\s*\)/.test(text)) schema.additionalProperties = false;
    return schema;
  }
  if (head === 'union') {
    const call = findCall(ts, node, 'union');
    const arr = call && call.arguments[0];
    if (arr && ts.isArrayLiteralExpression(arr)) {
      const parts = arr.elements.map((el) => zodToSchema(ts, el, sourceFile, nodes, depth + 1));
      if (parts.length && parts.every(Boolean)) return { oneOf: parts };
    }
    return null;
  }
  return null;
}

/** ObjectLiteralExpression of zod properties -> JSON Schema object. */
function objectSchema(ts, literal, sourceFile, nodes, depth) {
  if (!ts.isObjectLiteralExpression(literal)) return null;
  const properties = {};
  const required = [];
  let approximated = false;
  for (const prop of literal.properties) {
    if (!ts.isPropertyAssignment(prop)) {
      approximated = true;
      continue;
    }
    const key = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : null;
    if (!key) {
      approximated = true;
      continue;
    }
    const text = prop.initializer.getText(sourceFile);
    // z.never().optional() means "must be absent" - not a property.
    if (/^\s*z\s*\.\s*never\b/.test(text)) continue;
    const schema = zodToSchema(ts, prop.initializer, sourceFile, nodes, depth);
    if (schema) {
      properties[key] = schema;
    } else {
      // A cross-module import (passwordSchema from '@/lib/password') or a chain
      // this analyser will not guess at. Name the symbol instead of picking a
      // type that may be wrong.
      const symbol = text.match(/^\s*([A-Za-z_$][\w$]*)/);
      properties[key] = {
        description: symbol
          ? `Shape defined by \`${symbol[1]}\` in the application source.`
          : 'Shape not statically derivable.',
      };
      approximated = true;
    }
    if (!/\.optional\(\s*\)|\.default\(|\.nullish\(/.test(text)) required.push(key);
  }
  const out = { type: 'object', properties };
  if (required.length) out.required = required.slice().sort();
  if (approximated) out['x-approximate'] = true;
  return out;
}

/**
 * Best-effort request body for one handler:
 * { contentTypes, schema, source } where source is
 * 'zod' | 'zod-partial' | 'form-data' | 'unknown', or null when the handler
 * reads no body at all.
 *
 * `resolvedText` is the handler with its module-scope helpers inlined and is
 * what everything here probes; `handler.body` is only the fallback for a caller
 * that has not resolved anything. Reading the raw handler instead is what made
 * POST /api/admin/announcements and PATCH /api/admin/announcements/{id}
 * document as taking no payload: both call a module-scope readBody(request)
 * that does the request.json() / request.formData(), so nothing in the raw
 * handler text looks like a body read. They really accept both JSON and
 * multipart.
 */
function requestBodyFor(ts, handler, sourceFile, nodes, resolvedText) {
  const body = resolvedText || handler.body;
  const readsJson = /\b(?:request|req)\s*\.\s*json\s*\(/.test(body);
  const readsForm = /\bformData\s*\(/.test(body);
  if (!readsJson && !readsForm) return null;

  const contentTypes = [];
  if (readsJson) contentTypes.push('application/json');
  if (readsForm) contentTypes.push('multipart/form-data');

  if (!readsJson) {
    return { contentTypes, schema: { type: 'object', additionalProperties: true }, source: 'form-data' };
  }

  // Bind body -> handler by the `<name>.safeParse(` call INSIDE this handler.
  // Several files declare the schema AFTER the first handler, so proximity is
  // not a usable signal.
  for (const m of body.matchAll(/([A-Za-z_$][\w$]*)\s*\.\s*(?:safeParse|parse|safeParseAsync|parseAsync)\s*\(/g)) {
    const node = nodes.get(m[1]);
    if (!node) continue;
    const schema = zodToSchema(ts, node, sourceFile, nodes, 0);
    if (schema) {
      const approximate = JSON.stringify(schema).includes('"x-approximate":true');
      return { contentTypes, schema, source: approximate ? 'zod-partial' : 'zod' };
    }
    return {
      contentTypes,
      schema: {
        type: 'object',
        additionalProperties: true,
        description: `Validated by \`${m[1]}\` in the route file; the shape is not statically derivable.`,
      },
      source: 'unknown',
    };
  }
  return { contentTypes, schema: { type: 'object', additionalProperties: true }, source: 'unknown' };
}

// ---------------------------------------------------------------------------
// Query parameters
// ---------------------------------------------------------------------------

const PLAUSIBLE_QUERY = /^[A-Za-z][A-Za-z0-9_.-]{0,40}$/;

/**
 * Query keys read in a handler. Every `searchParams.get()` in this repo takes a
 * string literal, but the bag is bound three different ways and one of the
 * aliases is itself called `params`, so the identifier name is not a usable
 * signal - collect direct hits plus hits through any identifier assigned
 * `...searchParams`.
 *
 * Reads the RESOLVED text (helpers inlined), like every other probe here. That
 * is not a guess: it adds exactly two keys over the raw-handler reading, and
 * both are real - /api/calendar-events parses `?from=`/`?to=` in a module-scope
 * parseRange(), and /api/webhooks/jaas accepts its shared secret as `?secret=`
 * when the provider console cannot send a custom header. The second one matters:
 * with the raw text the access note claimed the header was the only way in.
 */
function queryParams(body) {
  const keys = new Set();
  for (const m of body.matchAll(/searchParams\s*\.\s*(?:get|has)\s*\(\s*['"]([^'"]+)['"]/g)) keys.add(m[1]);
  for (const m of body.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;]*\.searchParams\s*;/g)) {
    const re = new RegExp(`\\b${m[1]}\\s*\\.\\s*(?:get|has)\\s*\\(\\s*['"]([^'"]+)['"]`, 'g');
    for (const hit of body.matchAll(re)) keys.add(hit[1]);
  }
  return [...keys].filter((k) => PLAUSIBLE_QUERY.test(k)).sort();
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

// Every error body in this app is `{ error: string }`, and almost every success
// body is a plain JSON object, so the responses are declared once under
// components.responses and referenced. Inlining them 302 times made the
// generated document ~3x larger for no extra information.
const STATUS = {
  200: ['Ok', 'OK'],
  201: ['Created', 'Created'],
  204: ['NoContent', 'No content'],
  302: ['Redirect', 'Redirect'],
  303: ['Redirect', 'Redirect'],
  400: ['BadRequest', 'Validation failed'],
  401: ['Unauthorized', 'Unauthorized - missing or invalid credential'],
  403: ['Forbidden', 'Forbidden - authenticated but not allowed'],
  404: ['NotFound', 'Not found'],
  409: ['Conflict', 'Conflict'],
  410: ['Gone', 'Gone'],
  422: ['Unprocessable', 'Unprocessable entity'],
  429: ['RateLimited', 'Rate limited'],
  500: ['ServerError', 'Server error'],
  501: ['NotImplemented', 'Not implemented'],
  502: ['BadGateway', 'Upstream failure'],
  503: ['Unavailable', 'Service unavailable'],
};

/** components.responses, built from STATUS so the two cannot drift apart. */
function sharedResponses() {
  const out = {};
  for (const [code, [name, description]] of Object.entries(STATUS)) {
    if (out[name]) continue;
    const entry = { description };
    if (![204, 302, 303].includes(Number(code))) {
      entry.content = {
        'application/json': { schema: Number(code) >= 400 ? { $ref: '#/components/schemas/Error' } : { type: 'object' } },
      };
    }
    out[name] = entry;
  }
  return out;
}

/**
 * The statuses one operation really answers with.
 *
 * Reads the RESOLVED text, so a status produced by a module-scope gate helper
 * and handed straight back (`return NextResponse.json({ error: gate.error },
 * { status: gate.status })`) is declared. Eleven operations gained a status this
 * way - the 404 on /api/admin/organizations/{id}/pipeline-stages and
 * /api/admin/document-requirements, the 403 on the requisitions and
 * mentor-application gates, the 400/404/409 on POST /api/meetings/{id}/end -
 * each verified against the route file.
 *
 * Still incomplete, and deliberately silent about it rather than wrong: the
 * literal-only `status:\s*(\d{3})` scan cannot see a status behind a ternary
 * (`status: healthy ? 200 : 503`) or behind a variable it cannot constant-fold.
 * Under-declaring a status the endpoint can emit is recoverable; declaring one
 * it cannot is not - which is why the 401 below is added only for operations
 * that actually have a rejecting session guard (see classifyAuth: an endpoint
 * with no rejecting guard classifies `public` and gets no 401).
 */
function responsesFor(handler, urlPath, authClasses, resolvedText) {
  const body = resolvedText || handler.body;
  const codes = new Set();
  for (const m of body.matchAll(/status:\s*(\d{3})/g)) codes.add(Number(m[1]));
  // `{ status: healthy ? 200 : 503 }` - both arms are literal, so both are real.
  // This is why GET /api/health used to omit the 503 it genuinely answers with
  // when a subsystem probe fails. A status behind a plain variable
  // (`status: gate.status`) is still invisible here, but since every probe now
  // reads the resolved text the helper's own literal is usually picked up.
  for (const m of body.matchAll(/status:\s*[^,;{}()]*?\?\s*(\d{3})\s*:\s*(\d{3})/g)) {
    codes.add(Number(m[1]));
    codes.add(Number(m[2]));
  }
  const redirects = /NextResponse\s*\.\s*redirect\s*\(/.test(body);
  if (redirects) codes.add(303);
  // 18 handlers answer with a Buffer (avatars, CVs, attachments) or an .ics
  // feed. Declaring application/json for those makes Swagger UI try to render a
  // PDF as JSON.
  const binary = /new NextResponse\s*\(/.test(body) && /Buffer\.from\s*\(/.test(body);
  const calendar = /'text\/calendar/.test(body);
  if (/NextResponse\s*\.\s*json\s*\(/.test(body) || (!codes.size && !redirects)) codes.add(200);
  if (authClasses.some((c) => c.endsWith('-session') || c === 'api-key')) codes.add(401);
  if (WRITE_VERBS.has(handler.method) && !verifyExempt(urlPath)) codes.add(403);
  if (/enforceRateLimit\s*\(/.test(body)) codes.add(429);

  const binaryType = calendar ? 'text/calendar' : binary ? 'application/octet-stream' : null;
  const responses = {};
  for (const code of [...codes].sort((a, b) => a - b)) {
    const known = STATUS[code];
    if (binaryType && code < 400) {
      responses[String(code)] = {
        description: known ? known[1] : String(code),
        content: { [binaryType]: { schema: { type: 'string', format: 'binary' } } },
      };
    } else if (known) {
      responses[String(code)] = { $ref: `#/components/responses/${known[0]}` };
    } else {
      responses[String(code)] = { description: String(code) };
    }
  }
  return responses;
}

// ---------------------------------------------------------------------------
// Spec assembly
// ---------------------------------------------------------------------------

const operationIdFor = (method, urlPath) => {
  // '/' and '.' become '_', but a hyphen inside a segment is KEPT: collapsing
  // both to '_' made /api/mentor/applications and /api/mentor-applications
  // share the operationId get_mentor_applications, and Swagger UI drops one of
  // a duplicated pair without saying so.
  const tail = urlPath
    .replace(/^\/api/, '')
    .replace(/[{}]/g, '')
    .replace(/[^A-Za-z0-9-]+/g, '_')
    .replace(/_+$/, '');
  // Never derive from the last segment alone: 30 routes end in [id] and there
  // are duplicate merge/support/candidates/activity segments. Swagger UI
  // misbehaves silently on duplicate operationIds.
  return `${method.toLowerCase()}${tail || '_root'}`;
};

/**
 * Tag = the first path segment (admin, mentor, cron, v1, ...). 73 of them, one
 * per top-level area, which is what makes a 302-operation document navigable in
 * Swagger UI: the alternative - bucketing the small areas into "general" - put
 * 128 unrelated operations under one heading.
 */
function tagFor(urlPath) {
  return urlPath.split('/')[2] || 'general';
}

function buildSpec(repoRoot) {
  const apiDir = path.join(repoRoot, API_DIR);
  if (!fs.existsSync(apiDir)) return null;
  // Lazy: `typescript` is a devDependency. It IS present in the runtime image
  // (node_modules is copied from the builder, which installed devDeps), but
  // there is no reason to load a compiler when there is nothing to scan.
  const ts = require('typescript');

  const files = routeFiles(apiDir);
  const paths = {};
  const stats = { files: files.length, operations: 0, byAuth: {}, byBodySource: {}, byTag: {}, warnings: [] };

  for (const rel of files) {
    const { urlPath, params, catchAll } = urlPathFor(path.dirname(rel));
    const abs = path.join(apiDir, rel);
    const text = fs.readFileSync(abs, 'utf8');
    const sourceFile = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const { handlers, symbols, nodes } = collectModule(ts, sourceFile);
    const source = `${API_DIR}${path.sep}${rel}`.split(path.sep).join('/');

    if (!handlers.length) {
      stats.warnings.push(`${source}: no exported HTTP handler found`);
      continue;
    }

    // Cross-check the dynamic segment names against the `params:` annotation - a
    // mismatch is a bug in the route, not in the spec.
    for (const m of text.matchAll(/params:\s*Promise<\{\s*([A-Za-z_$][\w$]*)/g)) {
      if (!params.includes(m[1])) stats.warnings.push(`${source}: params annotation "${m[1]}" is not a directory segment (${params.join(', ') || 'none'})`);
    }

    const item = {};
    if (params.length) {
      item.parameters = params.map((name) => ({
        name,
        in: 'path',
        required: true,
        schema: { type: 'string' },
        ...(catchAll ? { description: 'One or more path segments, handled by a catch-all route.' } : {}),
      }));
    }

    for (const handler of handlers.slice().sort((a, b) => VERBS.indexOf(a.method) - VERBS.indexOf(b.method))) {
      const resolved = inlineHelpers(handler.body, symbols);
      const auth = classifyAuth(resolved, { params });
      const comment = leadingComment(ts, sourceFile, handler.node);
      const { summary, description } = summaryAndDescription(comment, handler.method, urlPath);

      const security = [];
      if (auth.classes.some((c) => c.endsWith('-session'))) security.push({ sessionCookie: [] });
      if (auth.classes.includes('api-key')) security.push({ bearerApiKey: [] });

      const authLine = auth.classes
        .map((c) => (c === 'role-session' ? AUTH_PROSE[c] + auth.roles.join(', ') + '.' : AUTH_PROSE[c]))
        .join(' ');
      const parts = [description, `**Access** - ${authLine}`, ...auth.notes];
      if (WRITE_VERBS.has(handler.method) && !verifyExempt(urlPath)) {
        parts.push('A signed-in user who has not verified their email address gets 403 on this write - enforced in middleware, before the handler runs.');
      }
      if (catchAll) {
        parts.push('Catch-all route: the path parameter absorbs one or more URL segments.');
      }
      if (auth.classes.includes('nextauth')) {
        parts.push('Do not exercise this from the explorer - it can end your own session mid-exploration.');
      }

      const op = {
        operationId: operationIdFor(handler.method, urlPath),
        summary,
        description: parts.filter(Boolean).join('\n\n'),
        tags: [tagFor(urlPath)],
      };

      const query = queryParams(resolved);
      if (query.length) op.parameters = query.map((name) => ({ name, in: 'query', required: false, schema: { type: 'string' } }));

      const body = requestBodyFor(ts, handler, sourceFile, nodes, resolved);
      if (body) {
        op.requestBody = { required: true, content: Object.fromEntries(body.contentTypes.map((ct) => [ct, { schema: body.schema }])) };
        op['x-body-source'] = body.source;
        stats.byBodySource[body.source] = (stats.byBodySource[body.source] || 0) + 1;
      }

      op.responses = responsesFor(handler, urlPath, auth.classes, resolved);
      // An explicit empty array means "this operation declares no scheme" -
      // read x-auth for how it is actually guarded (a shared-secret header, an
      // unguessable token, a SAML assertion, or genuinely nothing).
      op.security = security;

      op['x-auth'] = auth.classes[0];
      if (auth.classes.length > 1) op['x-auth-alternatives'] = auth.classes.slice(1);
      if (auth.roles.length) op['x-roles'] = auth.roles;
      if (auth.denied.length) op['x-roles-denied'] = auth.denied;
      // Roles that BYPASS a non-role guard rather than being required by it.
      if (auth.escapes.length) op['x-role-escape'] = auth.escapes;
      if (auth.approximate) op['x-auth-approximate'] = true;
      op['x-internal'] = !urlPath.startsWith('/api/v1');
      op['x-source'] = source;
      if (catchAll) op['x-catch-all'] = true;
      // Exercising the NextAuth surface from the page can destroy the caller's
      // own session. The explorer folds this into the same gate as
      // x-destructive: the request is confirmed in its requestInterceptor
      // before being sent, not hidden. See the note above DESTRUCTIVE.
      if (auth.classes.includes('nextauth')) op['x-try-it'] = false;
      if (DESTRUCTIVE.has(`${handler.method} ${urlPath}`)) op['x-destructive'] = true;
      if (/enforceRateLimit\s*\(/.test(resolved)) op['x-rate-limited'] = true;
      if (/withTenantScope\s*\(/.test(resolved)) op['x-tenant-scoped'] = true;
      if (/adminPassword|verifyTotp/.test(resolved)) op['x-step-up-auth'] = true;

      item[handler.method.toLowerCase()] = op;
      stats.operations += 1;
      stats.byAuth[auth.classes[0]] = (stats.byAuth[auth.classes[0]] || 0) + 1;
      stats.byTag[op.tags[0]] = (stats.byTag[op.tags[0]] || 0) + 1;
    }
    paths[urlPath] = item;
  }

  const sortedPaths = {};
  for (const key of Object.keys(paths).sort()) sortedPaths[key] = paths[key];

  const spec = {
    openapi: '3.1.0',
    info: {
      // Replaced at serve time with the derived app version.
      title: 'Internship CRM - internal API',
      version: '0.0.0',
      description: [
        'Every HTTP endpoint this application exposes, derived from the route files at build time.',
        '',
        'This document is **not public**. It is the complete internal route inventory - effectively an attack map - and is served only to a signed-in ADMIN. The public, key-authenticated subset (and the outgoing-webhook contract) has its own always-public document at `/api/v1/openapi.json`; none of that is duplicated here.',
        '',
        'Most operations authenticate with the NextAuth **session cookie** you are already carrying, so "Try it out" runs as you, with your own permissions. Operations tagged `v1` accept an admin-issued API key as a Bearer token instead.',
        '',
        'Role lists are derived statically and are indicative, never authoritative: an operation may additionally enforce per-record ownership or tenancy (`x-auth-approximate`), and a few guards live in helpers this analyser does not follow - where it cannot be sure it says only "requires a session" rather than guessing a role. The authoritative check is always the route file named in `x-source`.',
        '',
        'Request bodies are derived from the zod schema in the route file where that is unambiguous. An operation carrying `x-body-source: "unknown"` reads a body this analyser would not guess at - open the file named in `x-source`. Operations marked `x-destructive` are irreversible or send real email.',
      ].join('\n'),
    },
    servers: [{ url: '/' }],
    components: {
      securitySchemes: {
        sessionCookie: {
          type: 'apiKey',
          in: 'cookie',
          name: 'next-auth.session-token',
          description: 'The NextAuth session cookie. Set by signing in; the browser sends it automatically, so "Try it out" is already authenticated as you.',
        },
        bearerApiKey: {
          type: 'http',
          scheme: 'bearer',
          description: 'An admin-issued API key (icrm_...), created under Integrations or from the API explorer. Valid on the /api/v1 surface.',
        },
      },
      responses: sharedResponses(),
      schemas: {
        Error: {
          type: 'object',
          properties: { error: { type: 'string' } },
          required: ['error'],
          description: 'Uniform error shape across the whole API.',
        },
      },
    },
    tags: Object.keys(stats.byTag)
      .sort()
      .map((name) => ({ name, description: `Endpoints under /api/${name === 'general' ? '' : `${name}/`}` })),
    paths: sortedPaths,
    'x-generated': { by: 'scripts/openapi-generate.cjs', routeFiles: stats.files, operations: stats.operations },
  };
  return { spec, stats };
}

/**
 * Write src/generated/openapi.json. Returns the stats, or null when there is
 * nothing to scan. When src/app/api is absent - the production runtime image
 * ships no src/ - this prints a notice, leaves any existing file alone and
 * succeeds. A codegen step for a docs page must never be able to fail a build;
 * the caller (next.config.js) treats null as "no spec in this build".
 */
function generate(repoRoot = process.cwd(), outFile = OUT_FILE) {
  const built = buildSpec(repoRoot);
  if (!built) {
    console.log(`openapi: ${API_DIR} not present (runtime image) - keeping any existing ${outFile}, nothing to generate.`);
    return null;
  }
  const target = path.join(repoRoot, outFile);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(built.spec, null, 2)}\n`);
  return built.stats;
}

module.exports = {
  API_DIR,
  VERIFY_EXEMPT,
  DESTRUCTIVE,
  OUT_FILE,
  VERBS,
  urlPathFor,
  routeFiles,
  sanitizeComment,
  IGNORE_MARKER,
  summaryAndDescription,
  collectModule,
  inlineHelpers,
  guardConditions,
  classifyAuth,
  queryParams,
  requestBodyFor,
  zodToSchema,
  buildSpec,
  generate,
};

if (require.main === module) {
  const stats = generate(path.join(__dirname, '..'));
  if (stats) {
    const top = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' ');
    console.log(`openapi OK - ${stats.operations} operations in ${stats.files} route files -> ${OUT_FILE}`);
    console.log(`  auth:   ${top(stats.byAuth)}`);
    console.log(`  bodies: ${top(stats.byBodySource) || 'none'}`);
    console.log(`  tags:   ${top(stats.byTag)}`);
    for (const w of stats.warnings) console.log(`  warning: ${w}`);
  }
}
