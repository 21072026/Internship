// The one runner for the deploy's data migrations (#1540).
//
// Runs prisma/backfills/registry.mjs in order, each entry as its own
// `node <script> [args]` child (exactly what its deploy line used to do), and
// records the outcome in BackfillRun. A `once` entry with a recorded success is
// skipped. A failing entry fails the deploy unless it is `optional`, in which
// case the failure is printed (with its `failNote`) and the run goes on.
//
// The ledger is advisory to the run, never a gate on it: if it cannot be read
// or written (the table not there yet, a dropped connection), every entry runs
// as it did before the registry — they are idempotent — and the problem is
// logged. Losing the record must not lose the backfill.
//
// Ends with one summary line for the deploy log:
//   backfills: 30 registered, 26 ran ok, 4 skipped (once), 0 failed
//
// Exit codes, which infra/deploy-prod.sh reads (#1540, #3043):
//   0  every entry ran ok or was skipped
//   1  a REQUIRED entry failed — the deploy stops here, before the container
//      swap, so the running release keeps serving: a failed data migration
//      never takes prod down, it only keeps the new release out
//   3  only OPTIONAL entries failed — the deploy goes on, and announces each
//      failed id as a ::warning (annotation + step summary), so it is no
//      longer the silent `|| true` it replaced
//
// Run: node prisma/run-backfills.mjs   (infra/deploy-prod.sh, step 4)
//      node prisma/run-backfills.mjs --list   (the plan, nothing runs)
import { spawnSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { BACKFILLS } from './backfills/registry.mjs';

const listOnly = process.argv.includes('--list');
const prisma = new PrismaClient();

function log(line) {
  console.log(`[backfills] ${line}`);
}

async function ledger() {
  try {
    const rows = await prisma.backfillRun.findMany({ select: { id: true, firstOkAt: true } });
    return new Map(rows.map((r) => [r.id, r]));
  } catch (e) {
    log(`WARNING: ledger unreadable (${e instanceof Error ? e.message.split('\n')[0] : 'unknown'}) — running every entry`);
    return null;
  }
}

async function record(id, ok, error) {
  const now = new Date();
  try {
    await prisma.backfillRun.upsert({
      where: { id },
      create: { id, lastStatus: ok ? 'ok' : 'failed', lastRunAt: now, firstOkAt: ok ? now : null, runs: 1, lastError: error ?? null },
      update: { lastStatus: ok ? 'ok' : 'failed', lastRunAt: now, runs: { increment: 1 }, lastError: error ?? null },
    });
    // The first success only — a later success must not move it.
    if (ok) await prisma.backfillRun.updateMany({ where: { id, firstOkAt: null }, data: { firstOkAt: now } });
  } catch (e) {
    log(`WARNING: could not record ${id} (${e instanceof Error ? e.message.split('\n')[0] : 'unknown'})`);
  }
}

async function main() {
  const seen = await ledger();
  const counts = { ok: 0, skipped: 0, failed: 0 };
  let blocking = null;

  for (const entry of BACKFILLS) {
    if (entry.once && seen?.get(entry.id)?.firstOkAt) {
      counts.skipped++;
      log(`${entry.id}: skipped (once, done ${seen.get(entry.id).firstOkAt.toISOString()})`);
      continue;
    }
    if (listOnly) {
      log(`${entry.id}: would run node ${[entry.script, ...(entry.args ?? [])].join(' ')}${entry.optional ? '' : ' (required)'}`);
      continue;
    }
    log(`${entry.id}: node ${[entry.script, ...(entry.args ?? [])].join(' ')}`);
    const started = Date.now();
    const child = spawnSync(process.execPath, [entry.script, ...(entry.args ?? [])], { stdio: ['ignore', 'inherit', 'pipe'], encoding: 'utf8' });
    if (child.stderr) process.stderr.write(child.stderr);
    const ok = child.status === 0;
    // The line that names the problem: an Error line if there is one, else the
    // last line that is not Node's own version footer.
    const lines = (child.stderr || '').split('\n').map((l) => l.trim()).filter((l) => l && !/^Node\.js v\d/.test(l));
    const tail = (lines.find((l) => /Error\b/.test(l)) ?? lines.pop() ?? '').slice(0, 500);
    const error = ok ? null : `exit ${child.status ?? child.signal ?? 'unknown'}${tail ? `: ${tail}` : ''}`;
    await record(entry.id, ok, error);
    if (ok) {
      counts.ok++;
      log(`${entry.id}: ok (${Math.round((Date.now() - started) / 100) / 10}s)`);
      continue;
    }
    counts.failed++;
    log(`WARNING: ${entry.id} FAILED (${error})${entry.failNote ? ` — ${entry.failNote}` : ''}`);
    if (!entry.optional) {
      blocking = entry.id;
      break;
    }
  }

  log(`backfills: ${BACKFILLS.length} registered, ${counts.ok} ran ok, ${counts.skipped} skipped (once), ${counts.failed} failed${blocking ? ` — ${blocking} is required, stopping the deploy` : ''}`);
  // 0 = all ok · 1 = a required entry failed (the deploy stops) · 3 = only
  // optional entries failed (the deploy goes on and announces them).
  if (blocking) return 1;
  return counts.failed > 0 ? 3 : 0;
}

main()
  .then(async (code) => {
    await prisma.$disconnect();
    process.exit(code);
  })
  .catch(async (e) => {
    console.error('[backfills] runner crashed:', e);
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
