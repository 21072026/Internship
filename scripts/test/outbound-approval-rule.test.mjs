// Unit tests for the outbound approval rule (#2960, src/lib/outboundApprovalRule.ts):
// which automated mail an organization holds for an operator.
//
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DRAFT_MAX_AGE_DAYS,
  MAX_SCHEDULE_AHEAD_DAYS,
  OUTBOUND_APPROVAL_MODES,
  OUTBOUND_CATEGORIES,
  OUTBOUND_TRIGGERS,
  actionAllowed,
  draftNotAfter,
  maskAddress,
  outboundApprovalApplies,
  outboundBlockedReason,
  outboundDecision,
  parseOutboundApprovalMode,
  recipientKindForRole,
  statusAfter,
  triggerFor,
} from '../../src/lib/outboundApprovalRule.ts';
import { EMAIL_GROUPS } from '../../src/lib/emailGroups.ts';
import { verticalCapabilities } from '../../src/lib/verticals.ts';

const DAY = 24 * 60 * 60 * 1000;
const on = { mode: 'lead_mail', applies: true, hasOrg: true };

test('the mode: blank and off are off, lead_mail is on, a stray value is on (fail safe)', () => {
  assert.equal(parseOutboundApprovalMode(undefined), 'off');
  assert.equal(parseOutboundApprovalMode(null), 'off');
  assert.equal(parseOutboundApprovalMode(''), 'off');
  assert.equal(parseOutboundApprovalMode('off'), 'off');
  assert.equal(parseOutboundApprovalMode(' off '), 'off');
  assert.equal(parseOutboundApprovalMode('lead_mail'), 'lead_mail');
  assert.equal(parseOutboundApprovalMode('LEAD_MAIL'), 'lead_mail');
  assert.equal(parseOutboundApprovalMode('on'), 'lead_mail');
  assert.equal(parseOutboundApprovalMode('lead_mail_blocked'), 'lead_mail_blocked');
  assert.equal(parseOutboundApprovalMode(' lead_mail_blocked '), 'lead_mail_blocked');
});

test('only the sales vertical can hold mail; INTERNSHIP never does, whatever the row says', () => {
  assert.equal(outboundApprovalApplies(verticalCapabilities('MARKETING')), true);
  assert.equal(outboundApprovalApplies(verticalCapabilities('INTERNSHIP')), false);
  const d = outboundDecision({ mode: 'lead_mail', applies: false, hasOrg: true, category: 'stage-deadline', recipient: 'lead' });
  assert.deepEqual(d, { hold: false, block: false, code: 'approval_off' });
});

test('approval off: nothing is held, for any category or recipient', () => {
  for (const category of [...Object.keys(OUTBOUND_CATEGORIES), 'never-heard-of-it', undefined]) {
    for (const recipient of ['staff', 'lead', 'customer', 'contact', 'other']) {
      assert.equal(outboundDecision({ mode: 'off', applies: true, hasOrg: true, category, recipient }).hold, false);
    }
  }
});

test('approval on: an automated mail to a lead, a customer or a contact is held', () => {
  assert.deepEqual(outboundDecision({ ...on, category: 'stage-deadline', recipient: 'lead' }), { hold: true, block: false, code: 'held_lead' });
  assert.deepEqual(outboundDecision({ ...on, category: 'dormant-check-in', recipient: 'lead' }), { hold: true, block: false, code: 'held_lead' });
  assert.deepEqual(outboundDecision({ ...on, category: 're-engagement', recipient: 'customer' }), { hold: true, block: false, code: 'held_customer' });
  assert.deepEqual(outboundDecision({ ...on, category: 'meeting-guest-invite', recipient: 'contact' }), { hold: true, block: false, code: 'held_contact' });
  assert.deepEqual(outboundDecision({ ...on, category: 'message', recipient: 'other' }), { hold: true, block: false, code: 'held_other' });
});

test('staff is never held: the org\'s own ADMIN and MENTOR accounts', () => {
  assert.equal(recipientKindForRole('ADMIN'), 'staff');
  assert.equal(recipientKindForRole('MENTOR'), 'staff');
  assert.equal(recipientKindForRole('MENTEE'), 'lead');
  assert.equal(recipientKindForRole('COMPANY'), 'customer');
  assert.equal(recipientKindForRole('SOURCE'), 'other');
  assert.equal(recipientKindForRole(undefined), 'other');
  for (const category of Object.keys(OUTBOUND_CATEGORIES)) {
    assert.equal(outboundDecision({ ...on, category, recipient: 'staff' }).hold, false, category);
  }
});

test('exempt even when on: the account_security group and the person\'s own acknowledgement', () => {
  const security = EMAIL_GROUPS.find((g) => g.id === 'account_security');
  assert.ok(security);
  // The one essential-grouped category that is held: a cron's re-consent ask.
  const exemptSecurity = security.categories.filter((c) => c !== 'retention-reminder');
  assert.equal(OUTBOUND_CATEGORIES['retention-reminder']?.exempt, false);
  assert.deepEqual(outboundDecision({ ...on, category: 'retention-reminder', recipient: 'lead' }), { hold: true, block: false, code: 'held_lead' });
  assert.equal(outboundDecision({ ...on, category: 'retention-reminder', recipient: 'staff' }).hold, false);
  for (const category of exemptSecurity) {
    assert.equal(OUTBOUND_CATEGORIES[category]?.exempt, true, `${category} must be exempt`);
    assert.deepEqual(outboundDecision({ ...on, category, recipient: 'lead' }), { hold: false, block: false, code: 'exempt_category' });
  }
  // The demo form's double opt-in confirmation is `consent`.
  assert.equal(outboundDecision({ ...on, category: 'consent', recipient: 'contact' }).hold, false);
  assert.equal(outboundDecision({ ...on, category: 'mentor-application-received', recipient: 'contact' }).hold, false);
  // The acknowledgement of a public partner application (#3361): the person's own action.
  assert.equal(outboundDecision({ ...on, category: 'affiliate-application-received', recipient: 'contact' }).hold, false);
  // And nothing outside those is exempt.
  const exempt = Object.entries(OUTBOUND_CATEGORIES).filter(([, e]) => e.exempt).map(([c]) => c).sort();
  assert.deepEqual(exempt, [...exemptSecurity, 'mentor-application-received', 'affiliate-application-received'].sort());
});

test('an unknown or missing category is HELD (fail safe), and an org-less mail is never held', () => {
  assert.deepEqual(outboundDecision({ ...on, category: 'brand-new-mail', recipient: 'lead' }), { hold: true, block: false, code: 'held_lead' });
  assert.deepEqual(outboundDecision({ ...on, category: undefined, recipient: 'contact' }), { hold: true, block: false, code: 'held_contact' });
  assert.equal(triggerFor('brand-new-mail'), 'other');
  assert.deepEqual(outboundDecision({ ...on, hasOrg: false, category: 'stage-deadline', recipient: 'contact' }), { hold: false, block: false, code: 'no_org' });
});

test('every category the taxonomy knows has an explicit decision here', () => {
  const missing = EMAIL_GROUPS.flatMap((g) => g.categories).filter((c) => !(c in OUTBOUND_CATEGORIES));
  assert.deepEqual(missing, [], `classify these in OUTBOUND_CATEGORIES: ${missing.join(', ')}`);
  for (const [category, entry] of Object.entries(OUTBOUND_CATEGORIES)) {
    assert.ok(entry.why.length > 5, `${category} needs a reason`);
    if (!entry.exempt) assert.ok(OUTBOUND_TRIGGERS.includes(entry.trigger), `${category}: unknown trigger`);
  }
});

test('triggers name the family the operator reads', () => {
  assert.equal(triggerFor('stage-deadline'), 'deadline');
  assert.equal(triggerFor('dormant-check-in'), 'check_in');
  assert.equal(triggerFor('re-engagement'), 'win_back');
  assert.equal(triggerFor('consent'), 'other');
  assert.equal(triggerFor(null), 'other');
});

test('a draft expires at the sender\'s deadline, never later than the default age', () => {
  const held = new Date('2026-10-19T08:00:00Z');
  assert.equal(draftNotAfter(held).getTime(), held.getTime() + DRAFT_MAX_AGE_DAYS * DAY);
  const soon = new Date('2026-10-20T08:00:00Z');
  assert.equal(draftNotAfter(held, soon).getTime(), soon.getTime());
  const late = new Date('2027-01-01T00:00:00Z');
  assert.equal(draftNotAfter(held, late).getTime(), held.getTime() + DRAFT_MAX_AGE_DAYS * DAY);
  assert.equal(draftNotAfter(held, new Date('nope')).getTime(), held.getTime() + DRAFT_MAX_AGE_DAYS * DAY);
});

test('a draft is decided once: only DRAFT moves', () => {
  const now = new Date('2026-10-19T08:00:00Z');
  const draft = { status: 'DRAFT', notAfter: new Date(now.getTime() + 5 * DAY) };
  assert.equal(actionAllowed('send', draft, now), true);
  assert.equal(actionAllowed('discard', draft, now), true);
  for (const status of ['SCHEDULED', 'SENT', 'DISCARDED', 'EXPIRED']) {
    for (const action of ['send', 'schedule', 'discard']) {
      assert.equal(actionAllowed(action, { ...draft, status }, now, new Date(now.getTime() + DAY)), 'not_pending');
    }
  }
  // An expired one can still be discarded, never sent.
  const gone = { status: 'DRAFT', notAfter: new Date(now.getTime() - 1) };
  assert.equal(actionAllowed('send', gone, now), 'expired');
  assert.equal(actionAllowed('discard', gone, now), true);
  assert.equal(statusAfter('send'), 'SENT');
  assert.equal(statusAfter('schedule'), 'SCHEDULED');
  assert.equal(statusAfter('discard'), 'DISCARDED');
});

test('schedule: in the future, within the window, before the draft expires', () => {
  const now = new Date('2026-10-19T08:00:00Z');
  const draft = { status: 'DRAFT', notAfter: new Date(now.getTime() + 10 * DAY) };
  assert.equal(actionAllowed('schedule', draft, now, new Date(now.getTime() + DAY)), true);
  assert.equal(actionAllowed('schedule', draft, now, null), 'schedule_in_past');
  assert.equal(actionAllowed('schedule', draft, now, now), 'schedule_in_past');
  assert.equal(actionAllowed('schedule', draft, now, new Date('x')), 'schedule_in_past');
  assert.equal(actionAllowed('schedule', draft, now, new Date(now.getTime() + 11 * DAY)), 'schedule_after_expiry');
  const far = { status: 'DRAFT', notAfter: new Date(now.getTime() + 90 * DAY) };
  assert.equal(actionAllowed('schedule', far, now, new Date(now.getTime() + (MAX_SCHEDULE_AHEAD_DAYS + 1) * DAY)), 'schedule_too_far');
});

test('the list masks the address', () => {
  assert.equal(maskAddress('lead.person@acme-sales.example.test'), 'l***@acme-sales.example.test');
  assert.equal(maskAddress('x@y.test'), 'x***@y.test');
  assert.equal(maskAddress('no-at-sign'), '***');
  assert.equal(maskAddress('@y.test'), '***');
});

// ── lead_mail_blocked (#3771): the held mail is blocked instead ─────────────

const blocked = { mode: 'lead_mail_blocked', applies: true, hasOrg: true };

test('the setting has exactly three values, and the blocking one is new', () => {
  assert.deepEqual([...OUTBOUND_APPROVAL_MODES], ['off', 'lead_mail', 'lead_mail_blocked']);
});

test('blocked mode, every category × every recipient: staff passes, everybody else is blocked — no exemption', () => {
  // One assert per entry of OUTBOUND_CATEGORIES (and an unknown one), so a
  // category added later is checked in this mode too. Unlike lead_mail there is
  // no exempt category here: in a MARKETING org a lead never signs in (#3771).
  for (const category of [...Object.keys(OUTBOUND_CATEGORIES), 'never-classified', undefined]) {
    for (const recipient of ['staff', 'lead', 'customer', 'contact', 'other']) {
      const d = outboundDecision({ ...blocked, category, recipient });
      assert.equal(d.hold, false, `${category}/${recipient}: blocked mode never drafts`);
      if (recipient === 'staff') assert.deepEqual(d, { hold: false, block: false, code: 'staff_recipient' }, String(category));
      else assert.deepEqual(d, { hold: false, block: true, code: `blocked_${recipient}` }, `${category}/${recipient}`);
    }
  }
});

test('blocked mode: password reset, sign-in link, invitation and the DOI confirmation are blocked for a lead too; staff still gets them', () => {
  for (const category of ['password-reset', 'verification', 'consent', 'invitation', 'account', 'security', 'mentor-application-received']) {
    assert.deepEqual(outboundDecision({ ...blocked, category, recipient: 'lead' }), { hold: false, block: true, code: 'blocked_lead' }, category);
    assert.deepEqual(outboundDecision({ ...blocked, category, recipient: 'contact' }), { hold: false, block: true, code: 'blocked_contact' }, category);
    assert.deepEqual(outboundDecision({ ...blocked, category, recipient: 'staff' }), { hold: false, block: false, code: 'staff_recipient' }, category);
  }
  // lead_mail keeps its exemptions: the new mode changed nothing there.
  assert.deepEqual(outboundDecision({ ...on, category: 'password-reset', recipient: 'lead' }), { hold: false, block: false, code: 'exempt_category' });
});

test('blocked mode never applies outside the sales vertical, nor to a mail no org owns', () => {
  assert.deepEqual(outboundDecision({ ...blocked, applies: false, category: 'stage-deadline', recipient: 'lead' }), { hold: false, block: false, code: 'approval_off' });
  assert.deepEqual(outboundDecision({ ...blocked, hasOrg: false, category: 'stage-deadline', recipient: 'lead' }), { hold: false, block: false, code: 'no_org' });
});

test('a blocked mail is recorded with a reason that names it', () => {
  assert.equal(outboundBlockedReason('blocked_lead'), 'Blocked: outbound_blocked (blocked_lead)');
});
