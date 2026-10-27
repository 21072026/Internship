#!/usr/bin/env node
// Guard: an event leaves the product through ONE door (#1697).
//
// WHY THIS EXISTS
//   `dispatchWebhook()` posts straight to every subscribed receiver. A producer
//   that calls it directly skips everything `emit()` (#1693) guarantees: the
//   catalogue check, the `DomainEvent` row, the durable queue and every other
//   subscriber. Since #1697 all ten historical producers raise their event
//   through `emit()`, and the `webhook` subscriber is the only caller of the
//   dispatcher. This guard keeps it that way.
//
// TWO IDENTIFIERS, NOT ONE
//   `src/lib/webhooks.ts` exports two ways out: `dispatchWebhook(event, data)`
//   (fan-out to subscribers) and `deliverToWebhook(hook, event, data)` (one
//   signed POST to one receiver — the body dispatchWebhook itself sends). Six
//   lines copied out of the dispatcher reach every receiver without ever naming
//   `dispatchWebhook`, so both identifiers are scanned. The single legitimate
//   direct deliverer is the admin's test ping, allowlisted below.
//
// AUDIT ROWS FOR CATALOGUE EVENTS
//   A hand-written `prisma.activityLog.create` / `prisma.auditLog.create` (or
//   `tx.…`) whose `action` is a name the event catalogue owns is a second,
//   unvalidated record of a domain event — that row belongs to a subscriber
//   (#1685). The names are read from src/lib/events/catalog.ts itself, never
//   copied here. `logActivity()` is the activity log's own writer and is not
//   this rule's business.
//
// WHAT IT CANNOT SEE
//   This is a text scan, not a type checker: a commented-out call still counts
//   as a call, and a call reached through an alias (`import { dispatchWebhook as
//   fire }`) or a re-export does not. Both are the price of a grep-shaped guard
//   — the alias case is what code review is for.
//
// Run: node scripts/check-events.mjs   (npm run check:events)

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SRC_DIR = 'src';
const CATALOG = 'src/lib/events/catalog.ts';

// The only two files that may name the dispatcher freely — one defines it, the
// other is the single subscriber that turns a domain event into an HTTP delivery.
const DISPATCHER_HOMES = [
  ['src/lib/webhooks.ts', 'defines dispatchWebhook/deliverToWebhook'],
  ['src/lib/events/subscribers/webhook.ts', 'the webhook subscriber (#1693) — the one legitimate caller'],
];

// The one direct `deliverToWebhook` caller that is not a domain event at all:
// the admin's "send a test ping" button. A 'ping' is deliverable but not
// subscribable — it deliberately stays out of the catalogue — so it has nothing
// to emit(). Counted: a second call here is red.
const DIRECT_DELIVERY_ALLOWED = [
  ['src/app/api/admin/webhooks/test/route.ts', 1, "the admin test-ping — 'ping' is deliverable but not a domain event"],
];

// A file "reaches the dispatcher" if it invokes either exit or imports one.
// Both are checked: an import with no call is a re-export waiting to become a
// call. CALLS is global — the count is the point, not just the first hit.
const CALLS = /\b(?:dispatchWebhook|deliverToWebhook)\s*\(/g;
const IMPORTS = /\bimport\b[^;]*\b(?:dispatchWebhook|deliverToWebhook)\b[^;]*\bfrom\b/s;
// A hand-written audit/activity row; its argument is read up to the first `});`.
const LOG_WRITES = /\b\w+\.(activityLog|auditLog)\.create(?:Many)?\s*\(/g;
const ACTION = /\baction\s*:\s*['"`]([^'"`]+)['"`]/g;

function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

// Normalise so a Windows-style separator in an allowlist entry still matches.
const norm = (p) => p.split('\\').join('/');
const lineOf = (source, index) => source.slice(0, index).split('\n').length;

const problems = [];

// The catalogue's entries are the 4-space-indented `name: '…'` lines of
// EVENT_CATALOG. An empty result means the file changed shape under this
// script — red, rather than a rule that silently checks nothing.
const catalogNames = new Set(
  [...readFileSync(CATALOG, 'utf8').matchAll(/^ {4}name: '([a-z0-9_.]+)',$/gm)].map((m) => m[1])
);
if (catalogNames.size === 0) {
  problems.push(`${CATALOG}: no event names found — update the name pattern in scripts/check-events.mjs.`);
}

const homes = new Map(DISPATCHER_HOMES.map(([file, why]) => [file, why]));
const allowed = new Map(DIRECT_DELIVERY_ALLOWED.map(([file, calls, why]) => [file, { calls, why }]));
const files = sourceFiles(SRC_DIR).map(norm);
const seen = new Set();

for (const file of files) {
  const source = readFileSync(file, 'utf8');

  for (const write of source.matchAll(LOG_WRITES)) {
    const end = source.indexOf('});', write.index);
    const args = source.slice(write.index, end === -1 ? undefined : end);
    for (const action of args.matchAll(ACTION)) {
      if (catalogNames.has(action[1])) {
        problems.push(
          `${file}:${lineOf(source, write.index)}  writes ${write[1]} action '${action[1]}' by hand, but that name ` +
            `is a domain event in ${CATALOG}. Raise it with emit() and let a subscriber record it.`
        );
      }
    }
  }

  const calls = [...source.matchAll(CALLS)];
  const importAt = source.search(IMPORTS);
  if (calls.length === 0 && importAt === -1) continue;
  seen.add(file);
  if (homes.has(file)) continue;

  const recorded = allowed.get(file);
  if (recorded) {
    if (calls.length > recorded.calls) {
      problems.push(
        `${file}:${lineOf(source, calls[recorded.calls].index)}  is allowed ${recorded.calls} direct delivery call(s) ` +
          `but now has ${calls.length}. A domain event must leave through emit() (src/lib/events/emit.ts).`
      );
    }
    continue;
  }

  problems.push(
    `${file}:${lineOf(source, calls.length > 0 ? calls[0].index : importAt)}  reaches the webhook dispatcher ` +
      'directly. A domain event must leave through emit() (src/lib/events/emit.ts, #1693) so the catalogue ' +
      'check, the DomainEvent row, the durable queue and every subscriber apply to it; the webhook subscriber ' +
      'delivers it.'
  );
}

for (const [file, { why }] of allowed) {
  if (existsSync(file) && !seen.has(file)) {
    problems.push(`${file} (${why}) no longer reaches the dispatcher — drop it from DIRECT_DELIVERY_ALLOWED.`);
  }
}

for (const [file, why] of homes) {
  if (!existsSync(file)) {
    problems.push(`${file} (${why}) does not exist — update DISPATCHER_HOMES in this script.`);
  } else if (!seen.has(file)) {
    problems.push(`${file} (${why}) no longer names the dispatcher — update DISPATCHER_HOMES in this script.`);
  }
}

if (problems.length > 0) {
  console.error('event emission FAILED — a domain event has more than one door:\n');
  for (const problem of problems) console.error(`  • ${problem}`);
  console.error('\nSee the header of scripts/check-events.mjs and docs/domain-events.md.');
  process.exit(1);
}

console.log(
  `events OK — the dispatcher is reached only from ${DISPATCHER_HOMES.length} home module(s) and ` +
    `${allowed.size} allowlisted direct deliverer(s); no hand-written log row for any of ${catalogNames.size} ` +
    `catalogue events (${files.length} source files scanned).`
);
