// Provisioning quotas (#1752): the rule in src/lib/quotaRule.ts, and the CI
// guard the issue asks for — every limit key in src/lib/plans.ts must have an
// enforcement site, or an argued exemption, so a limit can no longer be printed
// on the pricing page and enforced nowhere (which is what #1752 found for three
// of them).
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { QUOTA_METRICS, QUOTA_LIMIT_KEY, quotaAllows, quotaError, takesAdminSeat } = await import('../../src/lib/quotaRule.ts');
const { PLANS } = await import('../../src/lib/plans.ts');

test('one more may be provisioned while usage + adding stays within the limit; null is unlimited', () => {
  assert.equal(quotaAllows(2, 1), true);
  assert.equal(quotaAllows(2, 2), false);
  assert.equal(quotaAllows(5, 3, 2), true);
  assert.equal(quotaAllows(5, 4, 2), false);
  assert.equal(quotaAllows(null, 10_000), true);
  assert.equal(quotaAllows(0, 0), false);
});

test('the 403 is the shared plan_limit_reached shape, with the metric', () => {
  const body = quotaError({ allowed: false, metric: 'ADMIN_SEATS', plan: 'community', limit: 2, usage: 2 });
  assert.equal(body.code, 'plan_limit_reached');
  assert.equal(body.metric, 'ADMIN_SEATS');
  assert.equal(body.limit, 2);
  assert.equal(body.usage, 2);
  assert.equal(body.plan, 'community');
});

test('FREE CORE: only an ADMIN takes a seat', () => {
  assert.equal(takesAdminSeat('ADMIN'), true);
  for (const role of ['MENTOR', 'MENTEE', 'COMPANY', 'SOURCE', 'AFFILIATE', null, undefined]) assert.equal(takesAdminSeat(role), false);
});

test('FREE CORE: no quota metric counts a mentor or a mentee', () => {
  for (const m of QUOTA_METRICS) assert.doesNotMatch(m, /MENTOR|MENTEE|USER/);
});

// ── The guard ────────────────────────────────────────────────────────────────

const root = process.cwd();
function sources(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}
const tree = sources(path.join(root, 'src')).map((p) => ({ p, text: readFileSync(p, 'utf8') }));
const calls = (pattern) => tree.filter(({ p, text }) => !p.endsWith('quota.ts') && !p.endsWith('quotaRule.ts') && pattern.test(text)).map(({ p }) => p);

// Where each limit is enforced, or why it is not (yet). A new key in
// PlanLimits fails here until it gets a line.
const ENFORCED = {
  activePairs: () => calls(/checkActiveRelationLimit(ForMentee)?\(/),
  adminSeats: () => calls(/enforceQuota\([^)]*'ADMIN_SEATS'/),
  companies: () => calls(/enforceQuota\([^)]*'COMPANIES'/),
  programs: () => calls(/enforceQuota\([^)]*'PROGRAMS'/),
  monthlyBroadcastRecipients: () => calls(/limits\.monthlyBroadcastRecipients/),
};
const EXEMPT = {
  aiCallsPerMonth:
    'The AI pack is a grant-only add-on (GRANT_ONLY_FEATURES); its monthly budget is Setting.aiMonthlyQuota, enforced in src/lib/aiGate.ts. The plan number is the band we quote, not a second quota.',
};

test('every plan limit has an enforcement site or an argued exemption', () => {
  const keys = Object.keys(PLANS[0].limits);
  for (const key of keys) {
    if (key in EXEMPT) {
      assert.ok(EXEMPT[key].length > 40, `${key}: an exemption needs its reason`);
      continue;
    }
    assert.ok(key in ENFORCED, `${key} is a plan limit with no enforcement site — add one (src/lib/quota.ts) or an argued EXEMPT entry here`);
    assert.ok(ENFORCED[key]().length > 0, `${key}: the enforcement call this guard looks for is gone`);
  }
  for (const m of QUOTA_METRICS) assert.ok(keys.includes(QUOTA_LIMIT_KEY[m]), `${m} reads a limit plans.ts does not have`);
});
