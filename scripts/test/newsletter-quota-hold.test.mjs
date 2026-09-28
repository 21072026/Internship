// Unit tests for the newsletter dispatch tick and the quota-hold alert (#2335).
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
//
// The failure these pin down cannot be staged cheaply in a browser: it takes a
// tick's worth of held issues from one tenant to starve every other tenant, and
// the interesting part — "a held attempt costs no budget, a tenant's later
// issues wait behind its held one" — is a property of the loop, not of a screen.
// e2e/broadcast-quota.spec.ts proves the same thing once against a real
// database; this file proves each clause of the rule on its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NEWSLETTER_TICK_BUDGET,
  buildNewsletterQuotaHoldAlert,
  describeHoldingOrg,
  runNewsletterTick,
} from '../../src/lib/newsletterQuotaHold.ts';

/** A fake dispatcher: tenants listed in `heldOrgs` are over their band. */
function dispatcher(heldOrgs, { throwsFor = [] } = {}) {
  const attempted = [];
  const attempt = async (issue) => {
    attempted.push(issue.id);
    if (throwsFor.includes(issue.id)) return null;
    if (heldOrgs.includes(issue.orgId)) return { id: issue.id, held: true };
    return { id: issue.id, held: false };
  };
  return { attempt, attempted };
}

const isHeld = (r) => r.held;

function issues(orgId, count, prefix = orgId) {
  return Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i + 1}`, orgId }));
}

test('the budget is ten attempts that could mail someone', () => {
  assert.equal(NEWSLETTER_TICK_BUDGET, 10);
});

test('one tenant over its band no longer starves another tenant (the #2335 regression)', async () => {
  // Eleven due issues from a spent tenant, all older than the other tenant's
  // one. The old tick attempted the first ten and stopped: `b-1` was never reached.
  const due = [...issues('a', 11), { id: 'b-1', orgId: 'b' }];
  const { attempt, attempted } = dispatcher(['a']);

  const run = await runNewsletterTick(due, attempt, { isHeld });

  assert.ok(attempted.includes('b-1'), 'the other tenant’s issue is attempted');
  assert.deepEqual(
    run.results.map((r) => r.id),
    ['a-1', 'b-1'],
  );
  assert.deepEqual(run.heldOrgs, ['a']);
});

test('a tenant with a held issue is checked once per tick; its later issues wait in order', async () => {
  const due = [...issues('a', 4), { id: 'b-1', orgId: 'b' }, ...issues('a', 2, 'a-late')];
  const { attempt, attempted } = dispatcher(['a']);

  const run = await runNewsletterTick(due, attempt, { isHeld });

  assert.deepEqual(attempted, ['a-1', 'b-1']);
  assert.deepEqual(run.waiting, ['a-2', 'a-3', 'a-4', 'a-late-1', 'a-late-2']);
});

test('a held attempt costs no budget; every other attempt does', async () => {
  const due = [
    { id: 'a-1', orgId: 'a' },
    ...issues('b', 3),
    ...issues('c', 3),
  ];
  const { attempt, attempted } = dispatcher(['a']);

  const run = await runNewsletterTick(due, attempt, { isHeld, budget: 3 });

  // a-1 was held (free), then three real attempts exhaust the budget.
  assert.deepEqual(attempted, ['a-1', 'b-1', 'b-2', 'b-3']);
  assert.equal(run.results.length, 4);
  // Budget exhaustion is not "waiting" — those were simply not reached.
  assert.deepEqual(run.waiting, []);
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
  const due = [{ id: 'x', orgId: 'b' }, { id: 'y', orgId: 'c' }, { id: 'z', orgId: 'b' }];
  const { attempt, attempted } = dispatcher([]);

  const run = await runNewsletterTick(due, attempt, { isHeld });

  assert.deepEqual(attempted, ['x', 'y', 'z']);
  assert.deepEqual(run.waiting, []);
  assert.deepEqual(run.heldOrgs, []);
});

test('legacy issues without a tenant share one bucket', async () => {
  const due = [{ id: 'n-1', orgId: null }, { id: 'n-2', orgId: null }, { id: 'b-1', orgId: 'b' }];
  const attempted = [];
  const run = await runNewsletterTick(
    due,
    async (issue) => {
      attempted.push(issue.id);
      return { id: issue.id, held: issue.orgId === null };
    },
    { isHeld },
  );
  assert.deepEqual(attempted, ['n-1', 'b-1']);
  assert.deepEqual(run.waiting, ['n-2']);
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
  const { subject, html } = buildNewsletterQuotaHoldAlert(facts);
  assert.match(subject, /Acme Akademi \(acme\)/);
  assert.match(html, /Acme Akademi \(acme\)/);
  assert.match(html, /250 \/ 250 alıcı/);
  assert.match(html, /40 alıcı/);
  assert.match(html, /2026-10-01/);
  assert.match(html, /2026-09-28/);
  assert.match(html, /nl_123/);
});

test('the alert escapes the editorial subject', () => {
  const { html } = buildNewsletterQuotaHoldAlert(facts);
  assert.ok(!html.includes('<tips>'));
  assert.match(html, /CV &lt;tips&gt; &amp; &quot;tricks&quot;/);
});

test('an unlimited or unknown figure never prints as "null"', () => {
  const { html } = buildNewsletterQuotaHoldAlert({ ...facts, limit: null, remaining: null, scheduledAt: null });
  assert.ok(!html.includes('null'));
  assert.match(html, /sınırsız/);
});

test('the org is described by whatever is known about it', () => {
  assert.equal(describeHoldingOrg({ orgName: 'Acme', orgSlug: 'acme' }), 'Acme (acme)');
  assert.equal(describeHoldingOrg({ orgName: null, orgSlug: 'acme' }), 'acme');
  assert.equal(describeHoldingOrg({ orgName: 'Acme', orgSlug: null }), 'Acme');
  assert.equal(describeHoldingOrg({ orgName: null, orgSlug: null }), 'bilinmeyen organizasyon');
});
