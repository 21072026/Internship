// The one runner for the steps before `prisma db push` (#3144).
//
// Runs prisma/pre-push/registry.mjs in order, each entry as its own
// `node <script> [args]` child: exactly what its deploy line used to do, one
// line per step in the log. The children run from the repo root, because the
// expand scripts read prisma/schema.prisma by relative path.
//
// Called by all three paths that push a schema onto a database with tables:
//   infra/deploy-prod.sh           (prod + preview)   node prisma/run-pre-push.mjs
//   infra/server/topic-deploy.sh   (existing PR DB)   node prisma/run-pre-push.mjs --keep-going || true
//   infra/server/demo-refresh.sh   (the public demo)  node prisma/run-pre-push.mjs
//
// Exit codes:
//   0  every required step ran ok (an optional failure is printed, not fatal)
//   1  a required step failed. Without --keep-going the run stops there,
//      because the push it was preparing would fail anyway, or worse, half-apply.
//
// Flags:
//   --keep-going  run every step even after a required failure, still exit 1
//                 (the topic deploy's best-effort mode)
//   --list        print the plan, run nothing
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PRE_PUSH_STEPS } from './pre-push/registry.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const keepGoing = process.argv.includes('--keep-going');
const listOnly = process.argv.includes('--list');

function log(line) {
  console.log(`[pre-push] ${line}`);
}

let failedRequired = null;
let failedOptional = 0;

for (const step of PRE_PUSH_STEPS) {
  const argv = [step.script, ...(step.args ?? [])];
  if (listOnly) {
    log(`${step.id}: would run node ${argv.join(' ')}${step.optional ? '' : ' (required)'}`);
    continue;
  }
  log(`${step.id}: node ${argv.join(' ')}`);
  const started = Date.now();
  const child = spawnSync(process.execPath, argv, { cwd: root, stdio: 'inherit', env: process.env });
  if (child.status === 0) {
    log(`${step.id}: ok (${Math.round((Date.now() - started) / 100) / 10}s)`);
    continue;
  }
  const how = `exit ${child.status ?? child.signal ?? child.error?.message ?? 'unknown'}`;
  if (step.optional) {
    failedOptional++;
    log(`WARNING: ${step.id} FAILED (${how}) — optional, continuing`);
    continue;
  }
  log(`ERROR: ${step.id} FAILED (${how})`);
  failedRequired ??= step.id;
  if (!keepGoing) break;
}

if (!listOnly) {
  log(
    `pre-push: ${PRE_PUSH_STEPS.length} steps, ` +
      (failedRequired ? `required step ${failedRequired} failed — do not push` : 'ready to push') +
      (failedOptional ? ` (${failedOptional} optional failed)` : ''),
  );
}
process.exit(failedRequired ? 1 : 0);
