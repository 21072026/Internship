// Regression tests for the compaction failure trail (#2323).
//
// WHY THIS EXISTS
//   The only thing this code produces is text a person has to be able to act
//   on, and the run that produces it happens once a day at 04:45 UTC with
//   nobody watching. Four failed runs in a row went unnoticed for three days
//   because the message existed but nowhere anyone looked; the replacement is
//   an issue that must carry the branch, the count, the version and the manual
//   step — and must NOT re-notify daily while nothing changes, or it becomes
//   the same kind of noise from the other direction.
//
//   Both of those are asserted here, because the alternative is finding out at
//   the next outage.
//
// USAGE
//   node --test scripts/test/release-compact-alert.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ALERT_LABEL,
  MAINTAINER,
  buildAnnotation,
  buildStuckIssue,
  compareUrl,
  formatCreateError,
  parseState,
  shouldComment,
} from '../release-compact-alert.mjs';

const ACTIONS_REFUSAL =
  'pull request create failed: GraphQL: GitHub Actions is not permitted to create or approve pull requests (createPullRequest)';

const ctx = {
  branch: 'bot/release-compact',
  count: '65',
  version: '0.181.0-beta',
  repo: '21072026/Internship',
  serverUrl: 'https://github.com',
  runUrl: 'https://github.com/21072026/Internship/actions/runs/34333371629',
};

test('the issue names the branch, the count and the version', () => {
  const { title, body } = buildStuckIssue(ctx);
  assert.match(title, /65 fragment/);
  assert.match(title, /0\.181\.0-beta/);
  assert.match(body, /bot\/release-compact/);
  assert.match(body, /\| Fragments compacted \| 65 \|/);
  assert.match(body, /0\.181\.0-beta/);
  assert.match(body, /actions\/runs\/34333371629/);
});

test('the issue carries the one-click manual step and says who owns the real fix', () => {
  const { body } = buildStuckIssue(ctx);
  assert.match(body, /compare\/main\.\.\.bot%2Frelease-compact\?expand=1/);
  assert.ok(body.includes(MAINTAINER), 'the body must name who decides the repo setting');
  assert.match(body, /#2323/);
  assert.match(body, /RELEASE_BOT_TOKEN/);
});

test('the branch name is URL-escaped in the compare link', () => {
  // A raw slash in the compare target 404s; every branch here has one.
  assert.equal(
    compareUrl(ctx),
    'https://github.com/21072026/Internship/compare/main...bot%2Frelease-compact?expand=1'
  );
});

test('the body stamps a state a later run can read back', () => {
  const { body } = buildStuckIssue(ctx);
  assert.deepEqual(parseState(body), { version: '0.181.0-beta', count: 65 });
});

test('parseState survives a body a human edited or wrote by hand', () => {
  assert.equal(parseState('someone rewrote this issue entirely'), null);
  assert.equal(parseState(''), null);
  assert.equal(parseState(undefined), null);
});

test('an unchanged backlog does not comment again', () => {
  // The daily re-run is the common case: refresh the body, stay silent.
  const previous = parseState(buildStuckIssue(ctx).body);
  assert.equal(shouldComment(previous, ctx), false);
});

test('a moved backlog comments once', () => {
  const previous = parseState(buildStuckIssue(ctx).body);
  assert.equal(shouldComment(previous, { ...ctx, count: '66' }), true);
  assert.equal(shouldComment(previous, { ...ctx, version: '0.182.0-beta' }), true);
});

test('a first failure does not comment — the issue body already says it', () => {
  assert.equal(shouldComment(null, ctx), false);
});

test('the annotation repeats the whole story on one line', () => {
  const line = buildAnnotation({ ...ctx, issueUrl: 'https://github.com/21072026/Internship/issues/2400' });
  assert.ok(line.startsWith('::error title='), 'must be an error annotation, not a notice');
  assert.equal(line.includes('\n'), false, 'a multi-line annotation is truncated by Actions');
  assert.match(line, /bot\/release-compact/);
  assert.match(line, /65 fragment/);
  assert.match(line, /0\.181\.0-beta/);
  assert.match(line, /issues\/2400/);
  assert.match(line, /#2323/);
});

test('the annotation still stands on its own when the issue could not be filed', () => {
  const line = buildAnnotation({ ...ctx, issueUrl: null });
  assert.match(line, /issues: write/);
  assert.match(line, /compare\/main/);
  assert.match(line, /#2323/);
});

test('the issue quotes what gh actually said, and does not assert the cause', () => {
  // The first version of this hardcoded "Actions is not permitted to create
  // pull requests" into the body. `gh pr create` also fails on an expired PAT,
  // a protected branch and an exhausted GraphQL quota — each with a different
  // fix — so an alert that names the wrong cause is worse than one that quotes.
  const expired = 'pull request create failed: HTTP 401: Bad credentials (https://api.github.com/graphql)';
  const { body } = buildStuckIssue({ ...ctx, createError: expired });
  assert.match(body, /Bad credentials/, 'the real stderr must be in the body');
  assert.match(body, /\*\*not\*\* the "Actions may not create pull requests" refusal/);
  assert.equal(
    /is not permitted to create pull\s+requests in this repository\*\*, so the fix is/.test(body),
    false,
    'an unrecognised error must not be reported as the known cause'
  );
});

test('the familiar refusal is still named as the cause when that is what happened', () => {
  const { body } = buildStuckIssue({ ...ctx, createError: ACTIONS_REFUSAL });
  assert.match(body, /not permitted to create pull/);
  assert.match(body, /so the fix is the repository decision below/);
  assert.match(body, new RegExp(MAINTAINER.replace('@', '@')));
});

test('a run that captured no stderr says so instead of inventing one', () => {
  const { body } = buildStuckIssue({ ...ctx, createError: '' });
  assert.match(body, /captured no stderr/);
  // With nothing to go on, the known cause is still the useful default guess —
  // it is what every observed failure was — but it is offered, not diagnosed.
  assert.match(body, /two options in #2323/);
});

test('formatCreateError keeps the tail, drops blank lines and caps the size', () => {
  // gh prints its real message LAST, so a truncation must keep the end.
  const noisy = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n\n');
  const out = formatCreateError(noisy, { maxLines: 3 });
  assert.equal(out, 'line 37\nline 38\nline 39');
  assert.equal(formatCreateError('   \n\n  '), null);
  assert.equal(formatCreateError(undefined), null);
  const huge = formatCreateError('x'.repeat(5000), { maxChars: 100 });
  assert.equal(huge.length, 101, 'capped, with the ellipsis marker');
  assert.ok(huge.startsWith('…'));
});

test('the annotation carries the real error on one line', () => {
  const line = buildAnnotation({ ...ctx, issueUrl: null, createError: `first\n${ACTIONS_REFUSAL}` });
  assert.equal(line.includes('\n'), false, 'a multi-line annotation is truncated by Actions');
  assert.match(line, /gh said: .*not permitted to create/);
});

test('the alert label is a fixed string', () => {
  // The workflow finds its own issue by this label; renaming it silently
  // orphans the open alert and starts duplicating.
  assert.equal(ALERT_LABEL, 'release-compact-stuck');
});
