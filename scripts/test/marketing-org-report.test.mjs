// Unit tests for prisma/check-marketing-orgs.mjs — the deploy-log readiness
// report of a MARKETING org (#2579).
//
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marketingOrgReport, crmBccLabel } from '../../prisma/check-marketing-orgs.mjs';

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
