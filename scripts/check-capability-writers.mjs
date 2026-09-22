#!/usr/bin/env node
/**
 * Guard: every writer of a vertical-gated model goes through requireCapability().
 *
 * WHY THIS EXISTS (#2364, epic #2348). A capability gate is only worth the
 * import if it sits on ALL of a module's write paths. #2352 gated the mentorship
 * modules and its own review found two Evaluation/Goal writers that had been
 * missed; #2363's review found more. The failure mode is always the same and it
 * is invisible to the type system: one route is gated, a second route (or a new
 * handler in the same file) writes the same model and is not, so the module is
 * "switched off" for a vertical that can still reach it with a direct POST.
 *
 * THE RULE. For every `*.<model>.<create|update|delete|upsert|…>(` call under
 * `src/`, walk back to the nearest preceding exported mutating HTTP handler
 * (`export async function POST|PUT|PATCH|DELETE`) and require that the text
 * between that handler's first line and the write contains a
 * `requireCapability(..., '<capability>')` call for the model's capability. A
 * write with no enclosing mutating handler is not a request path at all, so its
 * FILE must carry an explicit, reasoned entry in EXEMPT below — never a comment
 * somewhere else.
 *
 * WHAT IT CANNOT SEE, stated plainly so nobody reads a pass as a proof:
 *  - A write inside a helper function *declared after* the handler is attributed
 *    to that handler, so the guard would accept it on the handler's gate. That
 *    matches the truth in this tree today (the helpers that write these models
 *    live in `src/lib`, which has no handlers at all and is therefore handled by
 *    EXEMPT), but it is a heuristic, not a parser.
 *  - `e2e/`, `scripts/` and `prisma/` are deliberately out of scope: a spec, a
 *    deploy backfill and a CLI have no session to resolve a vertical from. They
 *    are reviewed as sessionless paths, the same way the tenant middleware's
 *    sessionless writers are.
 *  - It says nothing about READ paths. Capabilities gate writes (#2352); hiding
 *    a module from the nav is #2351's job.
 *
 * Run: node scripts/check-capability-writers.mjs   (npm run check:capability-writers)
 * Optional first argument: a root directory to scan instead of `src` (used by
 * scripts/test/capability-writers.test.mjs to exercise the guard on a fixture).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Model name as Prisma's client spells it → the capability its writes need.
// Extend this map when a module is gated; the guard then covers it from the
// same commit. Today it holds the `placements` module (#2364): offers,
// requisitions, interview requests and interview panels. The mentorship models
// gated by #2352 are NOT here yet — their writers reach into account erasure,
// duplicate merging and testimonials, each of which needs its own reasoned
// exemption, and that review is a separate change rather than a drive-by.
const MODELS = {
  offer: 'placements',
  requisition: 'placements',
  interviewRequest: 'placements',
  interviewPanel: 'placements',
  interviewPanelMember: 'placements',
};

// Files that write a gated model outside any request handler. Each entry is a
// promise that the path is sessionless and was reasoned about, with the reason
// in the value — a reader should never have to go find out why.
const EXEMPT = {
  'src/lib/offerNotify.ts':
    'expireOffers() is the scheduled expiry sweep. It runs from /api/cron with no session and ' +
    'no tenant context on purpose (see its header), so there is no actor whose vertical could be ' +
    'read. It also only ever flips an offer a gated handler already created, and letting an ' +
    'existing SENT offer expire is the safe direction: a vertical without `placements` cannot ' +
    'create one, and an offer already out there should stop being open rather than dangle.',
  'src/lib/mergeUsers.ts':
    'The duplicate-user merge re-points existing InterviewRequest rows at the surviving user. It ' +
    'creates no placement and changes no placement state; it is an admin identity operation whose ' +
    'own gate belongs to the merge endpoint. For a vertical without `placements` the loop has no ' +
    'rows to walk, so gating it would only fail merges over a module that tenant never used.',
};

const WRITE_METHODS = ['create', 'createMany', 'update', 'updateMany', 'delete', 'deleteMany', 'upsert'];
const MUTATING_HANDLERS = ['POST', 'PUT', 'PATCH', 'DELETE'];

const DEFAULT_ROOT = 'src';
const root = process.argv[2] ?? DEFAULT_ROOT;

function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(path);
  }
  return out;
}

const modelNames = Object.keys(MODELS).join('|');
const writeCall = new RegExp(`\\.(${modelNames})\\.(${WRITE_METHODS.join('|')})\\s*\\(`, 'g');
const handlerStart = new RegExp(`export\\s+async\\s+function\\s+(${MUTATING_HANDLERS.join('|')})\\s*\\(`, 'g');

const problems = [];
const unusedExemptions = new Set(Object.keys(EXEMPT));
let writes = 0;
let gatedWrites = 0;

for (const file of sourceFiles(root)) {
  const source = readFileSync(file, 'utf8');
  if (!new RegExp(`\\.(${modelNames})\\.`).test(source)) continue;

  const handlers = [];
  handlerStart.lastIndex = 0;
  for (let m = handlerStart.exec(source); m; m = handlerStart.exec(source)) {
    handlers.push({ at: m.index, method: m[1] });
  }

  writeCall.lastIndex = 0;
  for (let m = writeCall.exec(source); m; m = writeCall.exec(source)) {
    writes++;
    const [, model, method] = m;
    const capability = MODELS[model];
    const line = source.slice(0, m.index).split('\n').length;
    const handler = [...handlers].reverse().find((h) => h.at < m.index);

    if (!handler) {
      if (EXEMPT[file]) {
        unusedExemptions.delete(file);
        continue;
      }
      problems.push(
        `${file}:${line}  ${model}.${method}() is not inside an exported POST/PUT/PATCH/DELETE ` +
          'handler, so no capability gate can run in front of it. Move it behind a gated handler, ' +
          `or add ${file} to EXEMPT in this script with the reason it is sessionless.`,
      );
      continue;
    }

    const preamble = source.slice(handler.at, m.index);
    if (new RegExp(`requireCapability\\([^)]*'${capability}'\\s*\\)`).test(preamble)) {
      gatedWrites++;
      continue;
    }
    problems.push(
      `${file}:${line}  ${handler.method} writes ${model}.${method}() without ` +
        `requireCapability(…, '${capability}') in front of it. Gate the handler right after its ` +
        'session check, the way src/app/api/offers/route.ts does (#2364).',
    );
  }
}

// A stale exemption is drift in the other direction: it reads as a standing
// decision about a write path that is no longer there. Only meaningful against
// the real tree — a fixture root legitimately contains none of these files.
if (root === DEFAULT_ROOT) {
  for (const file of unusedExemptions) {
    problems.push(
      `${file} is listed in EXEMPT but no longer writes a gated model outside a handler — delete the entry.`,
    );
  }
}

if (problems.length > 0) {
  console.error('capability writers FAILED — a gated module has a write path that is not gated:\n');
  for (const problem of problems) console.error(`  • ${problem}`);
  console.error('\nSee src/lib/capabilityGate.ts and the header of this script.');
  process.exit(1);
}

console.log(
  `capability writers OK — ${writes} write(s) to ${Object.keys(MODELS).length} gated model(s) under ` +
    `${root}/: ${gatedWrites} behind a capability gate, ${writes - gatedWrites} in ` +
    `${Object.keys(EXEMPT).length} documented sessionless file(s).`,
);
