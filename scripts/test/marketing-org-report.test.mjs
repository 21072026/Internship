// Unit tests for prisma/check-marketing-orgs.mjs — the deploy-log readiness
// report of a MARKETING org (#2579).
//
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  marketingOrgReport,
  crmBccLabel,
  outboundApprovalLabel,
  countClaimableLeads,
  NO_LOGIN_PASSWORDS,
  isPendingActivation as mirrorPending,
  isPlaceholderEmail as mirrorPlaceholder,
  isErasedAccount as mirrorErased,
} from '../../prisma/check-marketing-orgs.mjs';
import { OUTBOUND_APPROVAL_MODES, parseOutboundApprovalMode } from '../../src/lib/outboundApprovalRule.ts';
import * as menteeAccount from '../../src/lib/menteeAccount.ts';

const READY = {
  id: 'org1',
  slug: 'acme',
  plan: 'PRO',
  publicHost: 'marketing.example.test',
  brandName: 'Acme Sales',
  stageKeys: ['LEAD_NEW', 'TRIAL_ACTIVE', 'TRIAL_EXPIRED', 'DEAL_WON'],
  activeAdmins: 1,
  activeReps: 3,
  defaultLeadOwnerId: 'u1',
  crmBcc: 'on',
  outboundApproval: 'lead_mail',
  claimableLeads: 0,
};

test('a fully set-up org has no gaps', () => {
  const r = marketingOrgReport(READY);
  assert.deepEqual(r.gaps, []);
  assert.match(r.summary, /^acme \(org1\): plan=PRO host=marketing\.example\.test/);
  assert.match(r.summary, /admins=1 reps=3 defaultOwner=set bccToCrm=on/);
});

test('no stage rows means the INTERNSHIP default pipeline', () => {
  const r = marketingOrgReport({ ...READY, stageKeys: [] });
  assert.equal(r.gaps.length, 1);
  assert.match(r.gaps[0], /INTERNSHIP default pipeline/);
});

test('a missing trial stage is named', () => {
  const r = marketingOrgReport({ ...READY, stageKeys: ['LEAD_NEW', 'TRIAL_ACTIVE'] });
  assert.match(r.gaps[0], /TRIAL_EXPIRED/);
  assert.doesNotMatch(r.gaps[0], /TRIAL_ACTIVE/);
});

test('every other gap is reported with what to do', () => {
  const r = marketingOrgReport({ ...READY, publicHost: null, activeAdmins: 0, activeReps: 0, defaultLeadOwnerId: null });
  assert.equal(r.gaps.length, 4);
  assert.ok(r.gaps.some((g) => g.includes('set-public-host.mjs --org acme')));
  assert.ok(r.gaps.some((g) => g === 'no active ADMIN'));
  assert.ok(r.gaps.some((g) => g.includes('/admin/users')));
  assert.ok(r.gaps.some((g) => g.includes('default lead owner')));
  assert.match(r.summary, /host=— brand=Acme Sales/);
});

test('BCC-to-CRM label: only an explicit false is off for MARKETING', () => {
  assert.equal(crmBccLabel(''), 'on');
  assert.equal(crmBccLabel('true'), 'on');
  assert.equal(crmBccLabel('false'), 'off');
});

// ── Outbound approval (#2960) ──────────────────────────────────────────────

test('the summary names the outbound-approval mode and the claimable-lead count', () => {
  const r = marketingOrgReport({ ...READY, claimableLeads: 7 });
  assert.match(r.summary, /outboundApproval=lead_mail claimableLeads=7$/);
  assert.deepEqual(r.gaps, []);
});

test('approval off is a gap that says where to switch it on', () => {
  const r = marketingOrgReport({ ...READY, outboundApproval: 'off' });
  assert.deepEqual(r.gaps, ['automated lead mail leaves without review: /admin/settings → outbound approval']);
  assert.match(r.summary, /outboundApproval=off/);
});

test('outboundApprovalLabel reads a stored value exactly as the rule does', () => {
  for (const stored of [undefined, null, '', '  ', 'off', ' off ', 'lead_mail', 'LEAD_MAIL', 'on', 'true', 'misspelt']) {
    assert.equal(outboundApprovalLabel(stored), parseOutboundApprovalMode(stored), JSON.stringify(stored));
  }
  // Its range is the rule's vocabulary, nothing more.
  assert.deepEqual([...new Set(['', 'lead_mail'].map(outboundApprovalLabel))].sort(), [...OUTBOUND_APPROVAL_MODES].sort());
});

test("the setting's stored default is 'off' in settings.ts — the report's blank-means-off agrees", () => {
  // Read as text so this report cannot drift from the defaults table unnoticed.
  const src = readFileSync(new URL('../../src/lib/settings.ts', import.meta.url), 'utf8');
  const m = /^\s*outboundApproval:\s*'([^']*)',/m.exec(src);
  assert.ok(m, 'outboundApproval default not found in src/lib/settings.ts');
  assert.equal(m[1], 'off');
  assert.equal(outboundApprovalLabel(m[1]), 'off');
  assert.equal(outboundApprovalLabel(''), 'off');
});

// ── Claimable leads (#2578) ────────────────────────────────────────────────

test('the no-login sentinels are exactly menteeAccount.ts\'s', () => {
  const ts = [menteeAccount.NO_LOGIN_PASSWORD, menteeAccount.IMPORTED_NO_LOGIN_PASSWORD, menteeAccount.APPLY_NO_LOGIN_PASSWORD];
  assert.deepEqual([...NO_LOGIN_PASSWORDS].sort(), [...ts].sort());
});

test('the mirrored predicates answer as menteeAccount.ts does', () => {
  const passwords = [...NO_LOGIN_PASSWORDS, '$2a$10$hash', '', '!something-else'];
  for (const password of passwords) {
    assert.equal(mirrorPending({ password }), menteeAccount.isPendingActivation({ password }), password);
  }
  const emails = ['a@example.test', 'x@import.local', 'X@IMPORT.LOCAL', 'y@erased.local', 'z@Erased.Local', 'no-at-sign', '', 'a@import.local.example'];
  for (const email of emails) {
    assert.equal(mirrorPlaceholder(email), menteeAccount.isPlaceholderEmail(email), email);
    assert.equal(mirrorErased({ email }), menteeAccount.isErasedAccount({ email }), email);
  }
});

test('claimable = no login yet AND a real address; stand-ins and erased records do not count', () => {
  const rows = [
    { email: 'lead1@example.test', password: '!created-no-login' },
    { email: 'lead2@example.test', password: '!apply-no-login' },
    { email: 'stand-in@import.local', password: '!imported-no-login' },
    { email: 'gone@erased.local', password: '!created-no-login' },
    { email: 'active@example.test', password: '$2a$10$realhash' },
  ];
  assert.equal(countClaimableLeads(rows), 2);
  assert.equal(countClaimableLeads([]), 0);
});
