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
//   Ten producers call the dispatcher directly today. Neither `emit()` nor the
//   catalogue exists in the tree yet, so those ten cannot move in this PR —
//   they are listed in PENDING_MIGRATION below with the event each one raises.
//   What this guard does today is cap the problem at ten: an ELEVENTH direct
//   call is a red build. As each producer moves onto `emit()`, its entry comes
//   off the list — and the guard fails on a stale entry too, so the list can
//   only shrink honestly, never rot into a permanent exemption.
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

// The dispatcher's own module, and the subscriber that is allowed to call it
// once the event spine lands. These are the only two files that may ever name
// `dispatchWebhook` — one defines it, the other is the single subscriber that
// turns a domain event into an HTTP delivery. Neither is required to exist yet.
const DISPATCHER_HOMES = [
  ['src/lib/webhooks.ts', 'defines dispatchWebhook/deliverToWebhook'],
  ['src/lib/events/subscribers/webhook.ts', 'the webhook subscriber (#1693) — the one legitimate caller'],
];

// Producers still calling the dispatcher directly, with the event each raises.
// Every entry here is waiting on the same thing: `emit()` (#1693) and the
// catalogue (#1691) do not exist yet, so there is nothing to move these onto.
// This is a burndown list, not an exemption list — delete the entry in the same
// commit that switches the producer to `emit()`.
const PENDING_MIGRATION = [
  ['src/app/api/apply/route.ts', 'application.created', 'public application intake'],
  ['src/app/api/mentorship/route.ts', 'mentorship.created', 'admin assigns a mentor'],
  ['src/app/api/interactions/route.ts', 'interaction.logged', 'mentor logs an interaction by hand'],
  ['src/lib/meetingAutoLog.ts', 'interaction.logged', 'auto-logged variant — a second payload shape for one event name'],
  ['src/app/api/evaluations/route.ts', 'evaluation.added', 'evaluation submitted'],
  ['src/app/api/meetings/route.ts', 'meeting.scheduled', 'batch invite — payload {title, scheduledAt, count}'],
  ['src/app/api/meetings/instant/route.ts', 'meeting.scheduled', 'instant meeting — a DIFFERENT shape for the same event name'],
  ['src/app/api/meeting-series/route.ts', 'meeting.scheduled', 'recurring series — a THIRD shape; #1691 reconciles all three'],
  ['src/app/api/interview-panels/[id]/score/route.ts', 'interview_panel.completed', 'last interviewer scores'],
  [
    'src/lib/stageChangeEffects.ts',
    'pipeline.stage_change',
    'must stay AFTER the from === to no-op guard, or a bulk advance floods the stream',
  ],
];

// A file "reaches the dispatcher" if it invokes it or imports it. Both are
// checked: an import with no call is a re-export waiting to become a call.
const CALLS = /\bdispatchWebhook\s*\(/;
const IMPORTS = /\bimport\b[^;]*\bdispatchWebhook\b[^;]*\bfrom\b/s;

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
const pending = new Map(PENDING_MIGRATION.map(([file, event, why]) => [file, { event, why }]));
const files = sourceFiles(SRC_DIR).map(norm);
const problems = [];
const seen = new Set();

for (const file of files) {
  const source = readFileSync(file, 'utf8');
  const callAt = source.search(CALLS);
  const importAt = source.search(IMPORTS);
  if (callAt === -1 && importAt === -1) continue;
  seen.add(file);
  if (homes.has(file) || pending.has(file)) continue;
  const at = callAt === -1 ? importAt : callAt;
  const line = source.slice(0, at).split('\n').length;
  problems.push(
    `${file}:${line}  reaches dispatchWebhook() directly. An event must leave through emit() ` +
      '(src/lib/events/emit.ts, #1693) so the queue, the DomainEvent row, tenant scoping and the ' +
      'audit trail apply to it. If emit() genuinely does not fit, say why in PENDING_MIGRATION — ' +
      'a silent entry there is how this guard rots.'
  );
}

// A burndown list that outlives its entries is how a guard rots: once a
// producer moves onto emit(), its line here has to go with it.
for (const [file, { event }] of pending) {
  if (!existsSync(file)) {
    problems.push(`${file} is on PENDING_MIGRATION but no longer exists — drop the entry (event: ${event}).`);
  } else if (!seen.has(file)) {
    problems.push(
      `${file} is on PENDING_MIGRATION but no longer reaches dispatchWebhook — it has been moved onto ` +
        `emit(). Delete its line from PENDING_MIGRATION in scripts/check-events.mjs (event: ${event}).`
    );
  }
}

for (const [file, why] of homes) {
  if (existsSync(file) && !seen.has(file)) {
    problems.push(`${file} (${why}) no longer names dispatchWebhook — update DISPATCHER_HOMES in this script.`);
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
  `events OK — dispatchWebhook is reached from ${liveHomes} dispatcher module(s) and ` +
    `${pending.size} producer(s) still awaiting emit() (#1693); no new direct call sites ` +
    `(${files.length} source files scanned).`
);
