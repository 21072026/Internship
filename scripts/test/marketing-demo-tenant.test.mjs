// Unit tests for the MARKETING demo tenant (#2443, story #2398).
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
//
// WHY THIS FILE EXISTS
//   prisma/seed-demo-marketing.mjs holds a PLAIN-ESM MIRROR of the shipped
//   MARKETING_FUNNEL stage preset, because the seeder runs inside the runtime
//   image — node:20-slim, no `src/`, no `--experimental-strip-types` — and
//   therefore cannot import `defaultTemplateForVertical()` the way every other
//   caller does. The same arrangement CLAUDE.md records for
//   prisma/skill-split.mjs ↔ src/lib/skills.ts, and it only holds because a
//   test compares the two: this one. A slice that adds, renames, recolours or
//   reorders a marketing stage (the trial pair, #2413, already did once) turns
//   this red until the mirror follows.
//
//   The rest of the file pins the properties that make the seeded data worth
//   seeding at all: thirty accounts, every stage occupied, and a stage history
//   that is a real walk through the funnel rather than a random scatter — which
//   is what the aging report and the cohort curves are drawn from.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import {
  MARKETING_DEMO_STAGES,
  MARKETING_DEMO_ACCOUNTS,
  MARKETING_DEMO_OWNERS,
  MARKETING_ORG_SLUG,
  LEAD_NO_LOGIN_PASSWORD,
  stagePathFor,
  transitionDaysFor,
} from '../../prisma/seed-demo-marketing.mjs';

// `programTemplates.ts` imports `./pipeline` and `@/i18n/config` — the
// specifiers the app's bundler resolves and Node's ESM resolver does not. The
// hook closes that gap and must be installed before the module loads, hence the
// dynamic import (a static one would be hoisted above the register() call).
register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { defaultTemplateForVertical, templateStagePayload } = await import('../../src/lib/programTemplates.ts');
const { NO_LOGIN_PASSWORD, isPendingActivation } = await import('../../src/lib/menteeAccount.ts');

const preset = defaultTemplateForVertical('MARKETING');

test('the MARKETING vertical still provisions from a preset', () => {
  assert.ok(preset, 'defaultTemplateForVertical("MARKETING") returned null — the demo tenant has no stages to seed');
});

test('the seeder mirror is the shipped preset, field for field', () => {
  // `templateStagePayload` is exactly what provisionStagePreset() hands to
  // replaceStages(), so comparing against it — rather than against
  // `preset.stages` — compares what actually reaches PipelineStage.
  assert.deepEqual(MARKETING_DEMO_STAGES, templateStagePayload(preset, 'en').stages);
});

test('the funnel runs LEAD_NEW … DEAL_LOST, in order, with one way out', () => {
  const keys = MARKETING_DEMO_STAGES.map((s) => s.key);
  assert.equal(keys[0], 'LEAD_NEW');
  assert.equal(keys.at(-1), 'DEAL_LOST');
  assert.deepEqual(
    MARKETING_DEMO_STAGES.map((s) => s.order),
    MARKETING_DEMO_STAGES.map((_, i) => i),
  );
  assert.deepEqual(MARKETING_DEMO_STAGES.filter((s) => s.isOffPath).map((s) => s.key), ['DEAL_LOST']);
});

test('thirty accounts, every one of them unique', () => {
  assert.equal(MARKETING_DEMO_ACCOUNTS.length, 30);
  for (const field of ['key', 'name', 'vatId']) {
    const values = MARKETING_DEMO_ACCOUNTS.map((a) => a[field]);
    assert.equal(new Set(values).size, values.length, `duplicate ${field} in MARKETING_DEMO_ACCOUNTS`);
  }
  // The VAT id is the idempotency key the seeder matches on (@@unique([orgId,
  // vatId])) — a duplicate there would silently collapse two accounts into one.
  for (const account of MARKETING_DEMO_ACCOUNTS) {
    assert.match(account.vatId, /^DE\d{9}$/, `${account.key}: VAT id is not a DE number`);
    assert.ok(account.owner >= 0 && account.owner < MARKETING_DEMO_OWNERS.length, `${account.key}: no such owner`);
  }
});

test('every stage of the funnel is occupied — no empty board column', () => {
  const occupied = new Set(MARKETING_DEMO_ACCOUNTS.map((a) => a.stage));
  for (const stage of MARKETING_DEMO_STAGES) {
    assert.ok(occupied.has(stage.key), `no demo account sits on ${stage.key}`);
  }
});

test('a record entered its current stage no earlier than it entered the funnel', () => {
  for (const account of MARKETING_DEMO_ACCOUNTS) {
    assert.ok(
      account.openedAt >= account.inStage,
      `${account.key}: inStage (${account.inStage}) is older than openedAt (${account.openedAt})`,
    );
    assert.ok(account.inStage >= 0 && account.openedAt > 0, `${account.key}: negative age`);
  }
});

test('every history is a real walk through the funnel, oldest first', () => {
  const order = new Map(MARKETING_DEMO_STAGES.map((s) => [s.key, s.order]));
  for (const account of MARKETING_DEMO_ACCOUNTS) {
    const path = stagePathFor(account);
    assert.equal(path[0], 'LEAD_NEW', `${account.key}: history does not start at LEAD_NEW`);
    assert.equal(path.at(-1), account.stage, `${account.key}: history does not end on the current stage`);
    // Strictly increasing stage order: a record never moves backwards, and
    // never skips into the off-path stage from nowhere.
    for (let i = 1; i < path.length; i++) {
      assert.ok(order.get(path[i]) > order.get(path[i - 1]), `${account.key}: ${path[i - 1]} → ${path[i]} goes backwards`);
    }
    // A lost deal fell out of the stage it says it fell out of.
    if (account.droppedFrom) {
      assert.equal(path.at(-2), account.droppedFrom);
      assert.ok(account.reasonCode, `${account.key}: an off-path move needs a drop-off reason (#810)`);
    }
  }
});

test('the back-dated transitions run from the funnel entry to the current stage', () => {
  for (const account of MARKETING_DEMO_ACCOUNTS) {
    const days = transitionDaysFor(account);
    const moves = stagePathFor(account).length - 1;
    assert.equal(days.length, moves, `${account.key}: ${days.length} timestamps for ${moves} moves`);
    if (moves === 0) continue;
    // Days-ago, so the numbers DESCEND as the record moves forward in time.
    assert.ok(days[0] <= account.openedAt, `${account.key}: first move predates the funnel entry`);
    assert.equal(days.at(-1), account.inStage, `${account.key}: the last move is not when it entered its stage`);
    for (let i = 1; i < days.length; i++) {
      assert.ok(days[i] <= days[i - 1], `${account.key}: moves are not in chronological order`);
    }
  }
});

test('an account on a trial stage carries a trial window', () => {
  for (const account of MARKETING_DEMO_ACCOUNTS) {
    if (account.stage === 'TRIAL_ACTIVE' || account.stage === 'TRIAL_EXPIRED') {
      assert.ok(account.trialDays > 0, `${account.key}: on ${account.stage} with no trialDays`);
    }
  }
});

test('a seeded lead person is a record, not a login', () => {
  // The second mirror in the seeder: the sentinel it writes into a lead's
  // password column must be one src/lib/menteeAccount.ts actually recognises,
  // or thirty demo leads become thirty sign-in-able MENTEE accounts in a tenant
  // whose vertical has no mentee portal.
  assert.equal(LEAD_NO_LOGIN_PASSWORD, NO_LOGIN_PASSWORD);
  assert.equal(isPendingActivation({ password: LEAD_NO_LOGIN_PASSWORD }), true);
});

test('the tenant slug is not the default org', () => {
  // The whole point of the task: a SECOND organization. Seeding onto `default`
  // would flip the internship tenant's vertical instead of adding one.
  assert.notEqual(MARKETING_ORG_SLUG, 'default');
});
