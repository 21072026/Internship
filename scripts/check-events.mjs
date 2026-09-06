#!/usr/bin/env node
// Guard: an event leaves the product through ONE door (#1697).
//
// WHY THIS EXISTS
//   `dispatchWebhook()` posts straight to every subscribed receiver from inside
//   the request handler that happened to notice something. Every direct caller
//   is a place where the next cross-cutting concern — a durable queue, a retry,
//   tenant scoping, a DomainEvent row, an audit entry, a timeline card — has to
//   be remembered and wired by hand, and silently does not apply where it was
//   not. The fix is `emit()` (#1693) validating against the versioned catalogue
//   (#1691): producers raise a domain event and subscribers react.
//
//   Ten call sites reach the dispatcher directly today. Neither `emit()` nor the
//   catalogue exists in the tree yet, so those ten cannot move in this PR — they
//   are listed in PENDING_MIGRATION below with the event each one raises. What
//   this guard does today is cap the problem at ten: an ELEVENTH direct call is
//   a red build. The cap is counted in CALL SITES, not files — a second
//   `dispatchWebhook()` added to a route that already has one is exactly the
//   next plausible direct call, and it is red too.
//
// TWO IDENTIFIERS, NOT ONE
//   `src/lib/webhooks.ts` exports two ways out: `dispatchWebhook(event, data)`
//   (fan-out to subscribers) and `deliverToWebhook(hook, event, data)` (one
//   signed POST to one receiver — the body dispatchWebhook itself sends). Six
//   lines copied out of the dispatcher reach every receiver without ever naming
//   `dispatchWebhook`, so both identifiers are scanned. The single legitimate
//   direct deliverer is the admin's test ping, allowlisted below.
//
// WHAT IT CANNOT SEE
//   This is a text scan, not a type checker: a commented-out call still counts
//   as a call, and a call reached through an alias (`import { dispatchWebhook as
//   fire }`) or a re-export does not. Both are the price of a grep-shaped guard.
//   It is a ratchet on the honest path, not a sandbox against a determined
//   bypass — the alias case is what code review is for.
//
// NOT CHECKED YET
//   #1697 also asks this guard to reject a `prisma.activityLog.create` /
//   `prisma.auditLog.create` written for an action name the event catalogue
//   owns. That needs the catalogue (#1691) to read the owned names from; with
//   no catalogue there is nothing to compare against, and the rule would either
//   pass vacuously or hardcode a second, forkable copy of the vocabulary. It is
//   deliberately left out until #1691 lands.
//
// Run: node scripts/check-events.mjs   (npm run check:events)

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SRC_DIR = 'src';

// The ratchet, counted in CALL SITES rather than files: two direct calls in one
// route file are two places the queue, the DomainEvent row and the audit trail
// silently do not apply. PENDING_MIGRATION's recorded counts must add up to
// exactly this number, so an eleventh direct call cannot be absorbed by
// appending a line to the list — it has to raise this constant, and this
// constant may only ever be LOWERED.
const PENDING_CALL_SITES = 10;

// The dispatcher's own module, and the subscriber that is allowed to call it
// once the event spine lands. These are the only two files that may name the
// dispatcher freely — one defines it, the other is the single subscriber that
// turns a domain event into an HTTP delivery. Neither is required to exist yet.
const DISPATCHER_HOMES = [
  ['src/lib/webhooks.ts', 'defines dispatchWebhook/deliverToWebhook'],
  ['src/lib/events/subscribers/webhook.ts', 'the webhook subscriber (#1693) — the one legitimate caller'],
];

// The one direct `deliverToWebhook` caller that is not a domain event at all:
// the admin's "send a test ping" button. A 'ping' is deliverable but not
// subscribable — it deliberately stays out of the catalogue — so it has nothing
// to emit(). Counted like the burndown entries: a second call here is red.
const DIRECT_DELIVERY_ALLOWED = [
  ['src/app/api/admin/webhooks/test/route.ts', 1, "the admin test-ping — 'ping' is deliverable but not a domain event"],
];

// Producers still calling the dispatcher directly, with the event each raises
// and how many direct calls the file is on record for. Every entry here is
// waiting on the same thing: `emit()` (#1693) and the catalogue (#1691) do not
// exist yet, so there is nothing to move these onto. This is a burndown list,
// not an exemption list — delete the entry in the same commit that switches the
// producer to `emit()`, and lower PENDING_CALL_SITES with it.
const PENDING_MIGRATION = [
  ['src/app/api/apply/route.ts', 'application.created', 1, 'public application intake'],
  ['src/app/api/mentorship/route.ts', 'mentorship.created', 1, 'admin assigns a mentor'],
  ['src/app/api/interactions/route.ts', 'interaction.logged', 1, 'mentor logs an interaction by hand'],
  ['src/lib/meetingAutoLog.ts', 'interaction.logged', 1, 'auto-logged variant — a second payload shape for one event name'],
  ['src/app/api/evaluations/route.ts', 'evaluation.added', 1, 'evaluation submitted'],
  ['src/app/api/meetings/route.ts', 'meeting.scheduled', 1, 'batch invite — payload {title, scheduledAt, count}'],
  ['src/app/api/meetings/instant/route.ts', 'meeting.scheduled', 1, 'instant meeting — a DIFFERENT shape for the same event name'],
  ['src/app/api/meeting-series/route.ts', 'meeting.scheduled', 1, 'recurring series — a THIRD shape; #1691 reconciles all three'],
  ['src/app/api/interview-panels/[id]/score/route.ts', 'interview_panel.completed', 1, 'last interviewer scores'],
  [
    'src/lib/stageChangeEffects.ts',
    'pipeline.stage_change',
    1,
    'must stay AFTER the from === to no-op guard, or a bulk advance floods the stream',
  ],
];

// A file "reaches the dispatcher" if it invokes either exit or imports one.
// Both are checked: an import with no call is a re-export waiting to become a
// call. CALLS is global — the count is the point, not just the first hit.
const CALLS = /\b(?:dispatchWebhook|deliverToWebhook)\s*\(/g;
const IMPORTS = /\bimport\b[^;]*\b(?:dispatchWebhook|deliverToWebhook)\b[^;]*\bfrom\b/s;

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

const homes = new Map(DISPATCHER_HOMES.map(([file, why]) => [file, why]));
const pending = new Map(PENDING_MIGRATION.map(([file, event, calls, why]) => [file, { event, calls, why }]));
const allowed = new Map(DIRECT_DELIVERY_ALLOWED.map(([file, calls, why]) => [file, { calls, why }]));
const files = sourceFiles(SRC_DIR).map(norm);
const problems = [];
const seen = new Set();

const budget = PENDING_MIGRATION.reduce((sum, [, , calls]) => sum + calls, 0);
if (budget !== PENDING_CALL_SITES) {
  problems.push(
    `PENDING_MIGRATION records ${budget} direct call site(s) but PENDING_CALL_SITES says ${PENDING_CALL_SITES}. ` +
      'The two must agree: lower PENDING_CALL_SITES as producers move onto emit(). It may only ever go down.'
  );
}

for (const file of files) {
  const source = readFileSync(file, 'utf8');
  const calls = [...source.matchAll(CALLS)];
  const importAt = source.search(IMPORTS);
  if (calls.length === 0 && importAt === -1) continue;
  seen.add(file);
  if (homes.has(file)) continue;

  const recorded = pending.get(file) ?? allowed.get(file);
  if (recorded) {
    // Listed, but the file has grown a call it is not on record for. This is the
    // "second dispatchWebhook in a route that already had one" case: six of the
    // listed files are route modules with several HTTP handlers.
    if (calls.length > recorded.calls) {
      const line = source.slice(0, calls[recorded.calls].index).split('\n').length;
      problems.push(
        `${file}:${line}  is on record for ${recorded.calls} direct call site(s) but now has ${calls.length}. ` +
          'A new direct call to the webhook dispatcher is not accepted — raise the event through emit() ' +
          '(src/lib/events/emit.ts, #1693), or land the change after #1693. The recorded number is a ' +
          'burndown figure and may only go down.'
      );
    } else if (calls.length < recorded.calls) {
      problems.push(
        `${file} is on record for ${recorded.calls} direct call site(s) but now has ${calls.length}. ` +
          (calls.length === 0
            ? 'It has been moved off the dispatcher — delete its line and lower PENDING_CALL_SITES in scripts/check-events.mjs.'
            : 'Lower its recorded count and PENDING_CALL_SITES in scripts/check-events.mjs in the same commit.')
      );
    }
    continue;
  }

  const at = calls.length > 0 ? calls[0].index : importAt;
  const line = source.slice(0, at).split('\n').length;
  problems.push(
    `${file}:${line}  reaches the webhook dispatcher directly. A domain event must leave through emit() ` +
      '(src/lib/events/emit.ts, #1693) so the queue, the DomainEvent row, tenant scoping and the audit ' +
      'trail apply to it. An eleventh direct producer is not accepted: move it onto emit(), or land it ' +
      'after #1693. PENDING_MIGRATION lists the ten call sites that predate this guard — it is a burndown ' +
      'list, not somewhere to add yourself for a green build.'
  );
}

// A burndown list that outlives its entries is how a guard rots: once a
// producer moves onto emit(), its line here has to go with it.
for (const [file, { event }] of pending) {
  if (!existsSync(file)) {
    problems.push(`${file} is on PENDING_MIGRATION but no longer exists — drop the entry (event: ${event}).`);
  } else if (!seen.has(file)) {
    problems.push(
      `${file} is on PENDING_MIGRATION but no longer reaches the webhook dispatcher — it has been moved onto ` +
        `emit(). Delete its line from PENDING_MIGRATION and lower PENDING_CALL_SITES in ` +
        `scripts/check-events.mjs (event: ${event}).`
    );
  }
}

for (const [file, { why }] of allowed) {
  if (existsSync(file) && !seen.has(file)) {
    problems.push(`${file} (${why}) no longer reaches the dispatcher — drop it from DIRECT_DELIVERY_ALLOWED.`);
  }
}

for (const [file, why] of homes) {
  if (existsSync(file) && !seen.has(file)) {
    problems.push(`${file} (${why}) no longer names the dispatcher — update DISPATCHER_HOMES in this script.`);
  }
}

if (problems.length > 0) {
  console.error('event emission FAILED — the webhook dispatcher has more than one door:\n');
  for (const problem of problems) console.error(`  • ${problem}`);
  console.error('\nSee the header of scripts/check-events.mjs and issue #1697.');
  process.exit(1);
}

const liveHomes = DISPATCHER_HOMES.filter(([file]) => existsSync(file)).length;
console.log(
  `events OK — the dispatcher is reached from ${liveHomes} dispatcher module(s), ${allowed.size} allowlisted ` +
    `direct deliverer(s) and ${PENDING_CALL_SITES} call site(s) across ${pending.size} producer(s) still ` +
    `awaiting emit() (#1693); no new direct call sites (${files.length} source files scanned).`
);
