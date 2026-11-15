// Team messaging on the sales surface (src/lib/salesTeamMessagingRule.ts):
// colleagues of one org may write to each other; leads, customers, other orgs
// and every INTERNSHIP org stay exactly where they were.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { salesColleaguesMayMessage, isSalesStaffOf, salesTeamKey, orgOfSalesTeamKey } = await import(
  '../../src/lib/salesTeamMessagingRule.ts'
);

const MARKETING = ['pipeline', 'companies'];
const INTERNSHIP = ['pipeline', 'companies', 'mentorship', 'projects'];
const person = (id, role, orgId = 'org-a', isActive = true) => ({ id, role, orgId, isActive });

test('two reps of one org may message each other, and a rep and an admin too', () => {
  assert.equal(salesColleaguesMayMessage(person('a', 'MENTOR'), person('b', 'MENTOR'), MARKETING), true);
  assert.equal(salesColleaguesMayMessage(person('a', 'MENTOR'), person('b', 'ADMIN'), MARKETING), true);
});

test('a lead or a customer login is never a colleague', () => {
  assert.equal(salesColleaguesMayMessage(person('a', 'MENTOR'), person('b', 'MENTEE'), MARKETING), false);
  assert.equal(salesColleaguesMayMessage(person('a', 'MENTOR'), person('b', 'COMPANY'), MARKETING), false);
});

test('another organisation is always no', () => {
  assert.equal(salesColleaguesMayMessage(person('a', 'MENTOR', 'org-a'), person('b', 'MENTOR', 'org-b'), MARKETING), false);
  assert.equal(salesColleaguesMayMessage(person('a', 'MENTOR', null), person('b', 'MENTOR', null), MARKETING), false);
});

test('a deactivated account is no colleague, and nobody messages themselves', () => {
  assert.equal(salesColleaguesMayMessage(person('a', 'MENTOR'), person('b', 'MENTOR', 'org-a', false), MARKETING), false);
  assert.equal(salesColleaguesMayMessage(person('a', 'MENTOR'), person('a', 'MENTOR'), MARKETING), false);
});

test('an INTERNSHIP org has no sales surface, so the rule never opens anything there', () => {
  assert.equal(salesColleaguesMayMessage(person('a', 'MENTOR'), person('b', 'MENTOR'), INTERNSHIP), false);
  assert.equal(isSalesStaffOf(person('a', 'ADMIN'), 'org-a', INTERNSHIP), false);
});

test('the team room opens for the org\'s active sales staff only', () => {
  assert.equal(isSalesStaffOf(person('a', 'MENTOR'), 'org-a', MARKETING), true);
  assert.equal(isSalesStaffOf(person('a', 'MENTOR'), 'org-b', MARKETING), false);
  assert.equal(isSalesStaffOf(person('a', 'MENTOR', 'org-a', false), 'org-a', MARKETING), false);
  assert.equal(isSalesStaffOf(person('a', 'MENTEE'), 'org-a', MARKETING), false);
});

test('the team key round-trips and refuses anything else', () => {
  assert.equal(orgOfSalesTeamKey(salesTeamKey('org-a')), 'org-a');
  assert.equal(orgOfSalesTeamKey('sales-team:'), null);
  assert.equal(orgOfSalesTeamKey('a|b'), null);
  assert.equal(orgOfSalesTeamKey(null), null);
});
