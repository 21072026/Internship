// Unit tests for the newsletter dispatch tick and the quota-hold alert (#2335).
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
//
// The failure these pin down cannot be staged cheaply in a browser: it takes a
// tick's worth of held issues from one tenant to starve every other tenant, and
// the interesting part — "a held attempt costs no budget, every issue is still
// metered on its own, a resume is never skipped" — is a property of the loop,
// not of a screen. e2e/broadcast-quota.spec.ts proves the starvation fix once
// against a real database; this file proves each clause of the rule on its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NEWSLETTER_HELD_PER_TENANT,
  NEWSLETTER_TICK_BUDGET,
  buildNewsletterQuotaHoldAlert,
  describeHoldingOrg,
  runNewsletterTick,
} from '../../src/lib/newsletterQuotaHold.ts';

/**
 * A fake dispatcher. An issue is held when its tenant is in `heldOrgs` — unless
 * it is listed in `fits` (a smaller issue that fits the band) or is a resume
 * (a resume is never metered, so it is never held).
 */
function dispatcher(heldOrgs, { throwsFor = [], fits = [] } = {}) {
  const attempted = [];
  const attempt = async (issue) => {
    attempted.push(issue.id);
    if (throwsFor.includes(issue.id)) return null;
    const held = issue.status !== 'SENDING' && heldOrgs.includes(issue.orgId) && !fits.includes(issue.id);
    return { id: issue.id, held };
  };
  return { attempt, attempted };
}

const isHeld = (r) => r.held;

function issues(orgId, count, prefix = orgId) {
  return Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i + 1}`, orgId, status: 'SCHEDULED' }));
}

test('the budget is ten attempts that could mail someone; a tenant gets as many held ones', () => {
  assert.equal(NEWSLETTER_TICK_BUDGET, 10);
  // The old tick attempted the ten oldest due issues: per tenant, no tenant is
  // worse off than it was.
  assert.equal(NEWSLETTER_HELD_PER_TENANT, NEWSLETTER_TICK_BUDGET);
});

test('one tenant over its band no longer starves another tenant (the #2335 regression)', async () => {
  // Eleven due issues from a spent tenant, all older than the other tenant's
  // one. The old tick attempted the first ten and stopped: `b-1` was never reached.
  const due = [...issues('a', 11), { id: 'b-1', orgId: 'b', status: 'SCHEDULED' }];
  const { attempt, attempted } = dispatcher(['a']);

  const run = await runNewsletterTick(due, attempt, { isHeld });

  assert.ok(attempted.includes('b-1'), 'the other tenant’s issue is attempted');
  assert.equal(run.results.find((r) => r.id === 'b-1')?.held, false);
  // Ten held attempts for `a` (its cap), the eleventh left for the next tick.
  assert.deepEqual(run.deferred, ['a-11']);
  assert.deepEqual(run.heldOrgs, ['a']);
});

test('every issue is metered on its own: a later issue that fits goes out past a held one', async () => {
  // The same tenant: an older, large issue the band holds, and a later, small
  // one that fits. The small one must not wait behind the big one — nothing
  // would ever mark it held, so it would stall with no signal.
  const due = [
    { id: 'a-big', orgId: 'a', status: 'SCHEDULED' },
    { id: 'a-small', orgId: 'a', status: 'SCHEDULED' },
  ];
  const { attempt, attempted } = dispatcher(['a'], { fits: ['a-small'] });

  const run = await runNewsletterTick(due, attempt, { isHeld });

  assert.deepEqual(attempted, ['a-big', 'a-small']);
  assert.deepEqual(
    run.results.map((r) => [r.id, r.held]),
    [
      ['a-big', true],
      ['a-small', false],
    ],
  );
  assert.deepEqual(run.deferred, []);
});

test('a resume is never deferred behind its tenant’s held issues', async () => {
  // Tenant `a` has an older issue X the band holds, and a half-delivered issue
  // Y (SENDING) from a run that died. Y cannot be edited, cancelled or re-sent;
  // this tick is the only thing that finishes it.
  const due = [
    { id: 'X', orgId: 'a', status: 'SCHEDULED' },
    { id: 'Y', orgId: 'a', status: 'SENDING' },
  ];
  const { attempt, attempted } = dispatcher(['a']);

  const run = await runNewsletterTick(due, attempt, { isHeld, heldPerTenant: 1 });

  assert.deepEqual(attempted, ['X', 'Y']);
  assert.deepEqual(run.deferred, []);
});

test('a tenant’s held attempts are capped per tick; only its further SCHEDULED issues are deferred', async () => {
  const due = [
    ...issues('a', 3),
    { id: 'b-1', orgId: 'b', status: 'SCHEDULED' },
    { id: 'a-resume', orgId: 'a', status: 'SENDING' },
    ...issues('a', 2, 'a-late'),
  ];
  const { attempt, attempted } = dispatcher(['a']);

  const run = await runNewsletterTick(due, attempt, { isHeld, heldPerTenant: 2 });

  assert.deepEqual(attempted, ['a-1', 'a-2', 'b-1', 'a-resume']);
  assert.deepEqual(run.deferred, ['a-3', 'a-late-1', 'a-late-2']);
});

test('a held attempt costs no budget; every other attempt does', async () => {
  const due = [{ id: 'a-1', orgId: 'a', status: 'SCHEDULED' }, ...issues('b', 3), ...issues('c', 3)];
  const { attempt, attempted } = dispatcher(['a']);

  const run = await runNewsletterTick(due, attempt, { isHeld, budget: 3 });

  // a-1 was held (free), then three real attempts exhaust the budget.
  assert.deepEqual(attempted, ['a-1', 'b-1', 'b-2', 'b-3']);
  assert.equal(run.results.length, 4);
  // Budget exhaustion is not "deferred" — those were simply not reached.
  assert.deepEqual(run.deferred, []);
});

test('a dispatch that threw still spends budget and yields no result', async () => {
  const due = issues('b', 3);
  const { attempt, attempted } = dispatcher([], { throwsFor: ['b-1'] });

  const run = await runNewsletterTick(due, attempt, { isHeld, budget: 2 });

  assert.deepEqual(attempted, ['b-1', 'b-2']);
  assert.deepEqual(
    run.results.map((r) => r.id),
    ['b-2'],
  );
});

test('the rule never reorders; with nothing held it is the old tick exactly', async () => {
  const due = [
    { id: 'x', orgId: 'b', status: 'SCHEDULED' },
    { id: 'y', orgId: 'c', status: 'SENDING' },
    { id: 'z', orgId: 'b', status: 'SCHEDULED' },
  ];
  const { attempt, attempted } = dispatcher([]);

  const run = await runNewsletterTick(due, attempt, { isHeld });

  assert.deepEqual(attempted, ['x', 'y', 'z']);
  assert.deepEqual(run.deferred, []);
  assert.deepEqual(run.heldOrgs, []);
});

test('legacy issues without a tenant share one bucket', async () => {
  const due = [
    { id: 'n-1', orgId: null, status: 'SCHEDULED' },
    { id: 'n-2', orgId: null, status: 'SCHEDULED' },
    { id: 'b-1', orgId: 'b', status: 'SCHEDULED' },
  ];
  const attempted = [];
  const run = await runNewsletterTick(
    due,
    async (issue) => {
      attempted.push(issue.id);
      return { id: issue.id, held: issue.orgId === null };
    },
    { isHeld, heldPerTenant: 1 },
  );
  assert.deepEqual(attempted, ['n-1', 'b-1']);
  assert.deepEqual(run.deferred, ['n-2']);
  assert.deepEqual(run.heldOrgs, ['']);
});

const facts = {
  newsletterId: 'nl_123',
  subject: 'CV <tips> & "tricks"',
  orgName: 'Acme Akademi',
  orgSlug: 'acme',
  used: 250,
  limit: 250,
  requested: 40,
  remaining: 0,
  resetsAt: '2026-10-01T00:00:00.000Z',
  scheduledAt: '2026-09-28T09:00:00.000Z',
};

test('the alert names the org that is holding the issue, and the figures', () => {
  const { subject, html } = buildNewsletterQuotaHoldAlert([facts]);
  assert.equal(subject, '[CRM] Bülten beklemede — Acme Akademi (acme) yayın kotasını doldurdu');
  assert.match(html, /Bir bülten sayısı/);
  assert.match(html, /Acme Akademi \(acme\)/);
  assert.match(html, /250 \/ 250 alıcı/);
  assert.match(html, /40 alıcı/);
  assert.match(html, /2026-10-01/);
  assert.match(html, /2026-09-28/);
  assert.match(html, /nl_123/);
});

test('one tick’s newly held issues are one mail, grouped by what holds them', () => {
  const second = { ...facts, newsletterId: 'nl_456', subject: 'Interview week' };
  const sameOrg = buildNewsletterQuotaHoldAlert([facts, second]);
  assert.equal(sameOrg.subject, '[CRM] 2 bülten beklemede — Acme Akademi (acme) yayın kotasını doldurdu');
  assert.match(sameOrg.html, /2 bülten sayısı/);
  assert.match(sameOrg.html, /nl_123/);
  assert.match(sameOrg.html, /nl_456/);

  const otherOrg = { ...second, orgName: 'Beta Kurs', orgSlug: 'beta' };
  const twoOrgs = buildNewsletterQuotaHoldAlert([facts, otherOrg]);
  assert.equal(twoOrgs.subject, '[CRM] 2 bülten beklemede — 2 organizasyonun yayın kotası dolu');
  assert.match(twoOrgs.html, /Acme Akademi \(acme\)/);
  assert.match(twoOrgs.html, /Beta Kurs \(beta\)/);
});

test('the alert escapes the editorial subject', () => {
  const { html } = buildNewsletterQuotaHoldAlert([facts]);
  assert.ok(!html.includes('<tips>'));
  assert.match(html, /CV &lt;tips&gt; &amp; &quot;tricks&quot;/);
});

test('an unlimited or unknown figure never prints as "null"', () => {
  const { html } = buildNewsletterQuotaHoldAlert([{ ...facts, limit: null, remaining: null, scheduledAt: null }]);
  assert.ok(!html.includes('null'));
  assert.match(html, /sınırsız/);
  assert.match(html, /bilinmiyor/);
});

test('an unparseable date is reported as unknown, not as "Invalid Date"', () => {
  const { html } = buildNewsletterQuotaHoldAlert([{ ...facts, scheduledAt: 'not-a-date' }]);
  assert.ok(!html.includes('Invalid'));
  assert.match(html, /Planlanan tarih: bilinmiyor/);
});

test('the org is described by whatever is known about it', () => {
  assert.equal(describeHoldingOrg({ orgName: 'Acme', orgSlug: 'acme' }), 'Acme (acme)');
  assert.equal(describeHoldingOrg({ orgName: null, orgSlug: 'acme' }), 'acme');
  assert.equal(describeHoldingOrg({ orgName: 'Acme', orgSlug: null }), 'Acme');
  assert.equal(describeHoldingOrg({ orgName: null, orgSlug: null }), 'bilinmeyen organizasyon');
});
