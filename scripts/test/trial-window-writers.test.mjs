// Ratchet: every writer of `MentorshipRelation.pipelineStatus` stamps the trial
// window (#2551, story #2392).
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
//
// WHY A RATCHET. The trial reminder ladder, the expiry sweep and the attention
// queue all skip a record whose `trialEndsAt` is null — correctly, since null
// means "no trial". So a stage writer that moves a record into TRIAL_ACTIVE and
// forgets the window does not fail: the trial is simply never reminded about and
// never expires, which is the exact silent loss the story exists to prevent, and
// nothing in the type system notices. Before #2551 *no* production path wrote
// the dates at all. The rule is `trialWindowFor()` in src/lib/trialReminderRule.ts;
// this file makes forgetting to call it a red test instead of a lost customer.
//
// THE RULE. A file under `src/` that calls a `mentorshipRelation` write
// (`create|createMany|update|updateMany|upsert`) AND names `pipelineStatus` as an
// object key (anything but `: true/false`, i.e. not a bare select) is a stage
// writer. It must call one of the STAMPERS below — or carry a reasoned entry in
// EXEMPT. An EXEMPT entry that no longer matches (the file stopped writing, or it
// now stamps) fails too, so the list cannot rot into a list of excuses.
//
// WHAT IT CANNOT SEE, stated plainly: it is a per-FILE heuristic, not a parser.
// A second writer added to a file that already stamps elsewhere passes; so does a
// write built in a helper in another file. `prisma/` and `scripts/` are out of
// scope on purpose — seeders and deploy backfills are sessionless one-offs that
// are reviewed as such (prisma/seed-demo-marketing.mjs writes its own windows).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

// Calls that stamp (or carry) the window, and the file that defines each. Every
// defining file must itself reach `trialWindowFor(` — or, for the transfer's
// copy, list the trial fields — so a stamper cannot quietly stop stamping.
const STAMPERS = {
  trialWindowFor: { file: 'src/lib/trialReminderRule.ts', proves: /export function trialWindowFor\(/ },
  stageTrialWindow: { file: 'src/lib/trialWindow.ts', proves: /\btrialWindowFor\(/ },
  funnelRelationCreateData: { file: 'src/lib/marketingImport.ts', proves: /\btrialWindowFor\(/ },
  funnelRelationUpdateData: { file: 'src/lib/marketingImport.ts', proves: /\btrialWindowFor\(/ },
  // A handover does not stamp a NEW window — it copies the one the closed
  // relation already has, so the successor counts from the same date.
  carriedOverFields: { file: 'src/lib/relationHistory.ts', proves: /'trialStartedAt',\s*'trialEndsAt'/ },
};

// File → why it writes `pipelineStatus`-adjacent data without stamping.
const EXEMPT = {
  'src/services/emailService.ts':
    'Reminder sweeps write only their own *SentAt claim stamps; `pipelineStatus` appears as a where filter and in a mail payload, never in a relation data block.',
  'src/lib/jobs/trialReminders.ts':
    'expireTrials() moves elapsed records OUT of TRIAL_ACTIVE into TRIAL_EXPIRED; the window it reads is the one that must stay. Its `pipelineStatus` key in the where is a filter.',
  'src/lib/dormantFirstContact.ts':
    'Writes only the dormancy stamps (dormantSince, nudge counters); `pipelineStatus` is read to find first-stage records, never written.',
};

const WRITE_CALL = /\bmentorshipRelation\s*\.\s*(?:create|createMany|update|updateMany|upsert)\s*\(/;
// `pipelineStatus` as an object key or shorthand — but not `pipelineStatus: true`
// (a select) and not a member access (`relation.pipelineStatus`).
const STATUS_KEY = /(?<![.\w])pipelineStatus\s*(?::(?!\s*(?:true|false)\b)|,|\})/;
const STAMP_CALL = new RegExp(`\\b(?:${Object.keys(STAMPERS).join('|')})\\s*\\(`);

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

/** Pure classification of one source text. */
export function classify(source) {
  const code = stripComments(source);
  const writes = WRITE_CALL.test(code) && STATUS_KEY.test(code);
  return { writes, stamps: STAMP_CALL.test(code) };
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

function stageWriters() {
  return walk(join(ROOT, 'src')).map((full) => {
    const file = relative(ROOT, full).split('\\').join('/');
    return { file, ...classify(readFileSync(full, 'utf8')) };
  });
}

test('every stage writer under src/ stamps the trial window or is EXEMPT with a reason', () => {
  const offenders = stageWriters()
    .filter((f) => f.writes && !f.stamps && !(f.file in EXEMPT))
    .map((f) => f.file);
  assert.deepEqual(
    offenders,
    [],
    'These files write MentorshipRelation.pipelineStatus without trialWindowFor()/stageTrialWindow(). ' +
      'Spread `...(await stageTrialWindow({ orgId, toStage, enteredAt, existing }))` into the same data ' +
      'block (src/lib/trialWindow.ts), or add a reasoned EXEMPT entry in this file.',
  );
});

test('the EXEMPT list has no stale entries', () => {
  const byFile = new Map(stageWriters().map((f) => [f.file, f]));
  for (const [file, reason] of Object.entries(EXEMPT)) {
    assert.ok(reason.length > 20, `${file}: an exemption needs a real reason`);
    const found = byFile.get(file);
    assert.ok(found, `${file} is EXEMPT but no longer exists`);
    assert.ok(found.writes, `${file} is EXEMPT but no longer writes pipelineStatus — delete the entry`);
    assert.ok(!found.stamps, `${file} is EXEMPT but now stamps — delete the entry`);
  }
});

test('every stamper still reaches trialWindowFor (or copies the trial fields)', () => {
  for (const [name, { file, proves }] of Object.entries(STAMPERS)) {
    const source = readFileSync(join(ROOT, file), 'utf8');
    assert.match(source, new RegExp(`export (?:async )?function ${name}\\b`), `${name} is not defined in ${file}`);
    assert.match(stripComments(source), proves, `${name} (${file}) no longer stamps/copies the trial window`);
  }
});

test('the known stage writers are recognised, and every one of them stamps', () => {
  const byFile = new Map(stageWriters().map((f) => [f.file, f]));
  // Writers that build the data block inline: the heuristic must see them, or
  // it has drifted and would miss the next one too.
  for (const file of [
    'src/app/api/mentorship/[id]/route.ts',
    'src/app/api/mentorship/route.ts',
    'src/app/api/mentor/mentees/route.ts',
    'src/app/api/register/route.ts',
    'src/app/api/status-changes/route.ts',
    'src/app/api/admin/candidates/bulk/route.ts',
    'src/lib/mentorshipDecision.ts',
  ]) {
    const f = byFile.get(file);
    assert.ok(f, `${file} missing`);
    assert.ok(f.writes, `${file} is not detected as a stage writer — the heuristic drifted`);
    assert.ok(f.stamps, `${file} does not stamp the trial window`);
  }
  // Writers that delegate the data block to a stamper (the import builders, the
  // transfer's copy): there is no literal key for the heuristic to see, so the
  // call to the stamper is pinned here instead.
  for (const [file, stamper] of [
    ['src/lib/marketingImportStore.ts', /\bfunnelRelationCreateData\(/],
    ['src/lib/marketingImportStore.ts', /\bfunnelRelationUpdateData\(/],
    ['src/lib/mentorTransfer.ts', /\.\.\.carriedOverFields\(relation\)/],
  ]) {
    const source = stripComments(readFileSync(join(ROOT, file), 'utf8'));
    assert.match(source, stamper, `${file} no longer builds its funnel write through ${stamper}`);
  }
});

// ── The ratchet catches a new writer ─────────────────────────────────────────

test('a new stage writer that does not stamp is caught', () => {
  const src = `
    export async function POST() {
      await prisma.mentorshipRelation.update({ where: { id }, data: { pipelineStatus: to } });
    }`;
  assert.deepEqual(classify(src), { writes: true, stamps: false });
});

test('shorthand pipelineStatus in a create is a write too', () => {
  const src = `await tx.mentorshipRelation.create({ data: { mentorId, menteeId, pipelineStatus } });`;
  assert.equal(classify(src).writes, true);
});

test('the same writer spreading stageTrialWindow passes', () => {
  const src = `
    await prisma.mentorshipRelation.update({
      where: { id },
      data: { pipelineStatus: to, ...(await stageTrialWindow({ orgId, toStage: to, enteredAt: now, existing })) },
    });`;
  assert.deepEqual(classify(src), { writes: true, stamps: true });
});

test('a select of pipelineStatus next to an unrelated write is not a stage writer', () => {
  const src = `
    const r = await prisma.mentorshipRelation.findUnique({ where: { id }, select: { pipelineStatus: true } });
    if (r.pipelineStatus === x) await prisma.mentorshipRelation.update({ where: { id }, data: { dormantSince: null } });`;
  assert.equal(classify(src).writes, false);
});

test('a mention inside a comment does not count as a stamp', () => {
  const src = `
    // remember to call trialWindowFor() here
    await prisma.mentorshipRelation.update({ where: { id }, data: { pipelineStatus: to } });`;
  assert.deepEqual(classify(src), { writes: true, stamps: false });
});
