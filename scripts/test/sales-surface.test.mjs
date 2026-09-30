// Unit tests for the MARKETING sales surface rule (#2580).
//
// Who works on /sales is one function, and three ways it could go wrong would
// all pass a glance:
//   • an INTERNSHIP mentor getting it — INTERNSHIP must stay byte-identical, and
//     the mentor shell's redirect to /sales must never fire for it;
//   • a MARKETING lead (MENTEE) or customer login (COMPANY) getting it — they are
//     records/customers, not operators, and keep /account;
//   • opening it by granting `mentorship` to MARKETING, which would switch on the
//     whole mentor shell and every #2352-gated write.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasSalesSurface,
  mentorlessShellTarget,
  SALES_ATTENTION_REASONS,
  SALES_HOME,
  NEUTRAL_HOME,
  salesRecordLink,
  salesLeadHref,
  interactionReminderApplies,
} from '../../src/lib/salesSurface.ts';
import { verticalCapabilities } from '../../src/lib/verticals.ts';
import { SALES_NAV_LINKS, visibleNavLinks } from '../../src/lib/navLinks.ts';

const INTERNSHIP = verticalCapabilities('INTERNSHIP');
const MARKETING = verticalCapabilities('MARKETING');

test('MARKETING does not carry mentorship — the surface is opened by pipeline', () => {
  assert.ok(!MARKETING.includes('mentorship'));
  assert.ok(MARKETING.includes('pipeline'));
});

test('a MARKETING MENTOR — and an ADMIN who also sells — has the sales surface', () => {
  assert.equal(hasSalesSurface('MENTOR', MARKETING), true);
  assert.equal(hasSalesSurface('ADMIN', MARKETING), true);
  for (const role of ['MENTEE', 'COMPANY', 'SOURCE', undefined, null]) {
    assert.equal(hasSalesSurface(role, MARKETING), false, `${role} in MARKETING`);
  }
  for (const role of ['ADMIN', 'MENTOR', 'MENTEE', 'COMPANY', 'SOURCE']) {
    assert.equal(hasSalesSurface(role, INTERNSHIP), false, `${role} in INTERNSHIP`);
  }
});

test('a vertical without a pipeline has no sales surface either', () => {
  assert.equal(hasSalesSurface('MENTOR', ['companies', 'messaging']), false);
});

test('the mentor shell sends a MARKETING MENTOR or ADMIN to /sales and everyone else to /account', () => {
  assert.equal(mentorlessShellTarget('MENTOR', MARKETING), SALES_HOME);
  assert.equal(mentorlessShellTarget('ADMIN', MARKETING), SALES_HOME);
  assert.equal(mentorlessShellTarget('MENTEE', MARKETING), NEUTRAL_HOME);
  assert.equal(SALES_HOME, '/sales');
  assert.equal(NEUTRAL_HOME, '/account');
});

test('the sales queue keeps the sales reasons and none of the mentorship ones', () => {
  assert.deepEqual([...SALES_ATTENTION_REASONS].sort(), ['next_action_due', 'overdue', 'trial_expired', 'trial_no_end_date']);
  for (const mentorship of ['inactive', 'unanswered_question', 'pending_meeting', 'no_open_goal', 'missing_weekly_reports']) {
    assert.ok(!SALES_ATTENTION_REASONS.includes(mentorship), mentorship);
  }
});

test('MARKETING keeps every sales link, and every one stays inside /sales', () => {
  const shown = visibleNavLinks(SALES_NAV_LINKS, MARKETING);
  assert.equal(shown.length, SALES_NAV_LINKS.length);
  for (const link of SALES_NAV_LINKS) {
    assert.ok(link.href === '/sales' || link.href.startsWith('/sales/'), link.href);
    assert.ok(link.capability && MARKETING.includes(link.capability), `${link.href} is tagged with a MARKETING capability`);
  }
});

test('a sales rep\'s record reminders deep-link to the lead page, everyone else keeps their link', () => {
  assert.equal(salesRecordLink('MENTOR', MARKETING, 'rel_1'), '/sales/leads/rel_1');
  assert.equal(salesLeadHref('rel_1'), '/sales/leads/rel_1');
  assert.equal(salesRecordLink('MENTOR', MARKETING, null), SALES_HOME);
  // INTERNSHIP mentors keep /mentor/mentees/<id> (null = caller's own link).
  assert.equal(salesRecordLink('MENTOR', INTERNSHIP, 'rel_1'), null);
  for (const role of ['ADMIN', 'MENTEE', 'COMPANY', 'SOURCE']) {
    assert.equal(salesRecordLink(role, MARKETING, 'rel_1'), null, `${role} in MARKETING`);
  }
});

test('the "no contact in N days" reminder is mentorship work — none for a MARKETING book', () => {
  assert.equal(interactionReminderApplies(INTERNSHIP), true);
  assert.equal(interactionReminderApplies(MARKETING), false);
  // The same line the sales queue draws.
  assert.ok(!SALES_ATTENTION_REASONS.includes('inactive'));
});
