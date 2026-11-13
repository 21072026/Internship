// Unit tests for the prospect retention rule (MKT-4).
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
//
// WHAT THIS PINS
//   The letters promise "längstens 24 Monate nach dem letzten Kontakt"; the
//   review list is what finds the accounts that promise has run out for. Each
//   exclusion is pinned on its own, because each one, lost, puts an account in
//   front of an erase button that must not be there:
//     customer history (through the SHARED ever-won helper), a live permission,
//     a recent contact through each of the three signals, an account already
//     erased, and an org outside the sales-surface vertical.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const {
  ERASED_ADDRESS_BLOCK,
  PROSPECT_RETENTION_MONTHS,
  PROSPECT_REVIEW_LIMIT,
  hasContactData,
  hasLivePermission,
  judgeProspect,
  letterSnapshotErasureData,
  overdueProspects,
  prospectLastContact,
  prospectRetentionApplies,
  prospectRetentionCutoff,
} = await import('../../src/lib/prospectRetentionRule.ts');
const { recordsEverWon, wonHistoryWhere, WON_STAGE_KEY } = await import('../../src/lib/accountEventRule.ts');
const templates = await import('../../src/lib/postCampaignTemplates.ts');

const NOW = new Date('2026-11-13T12:00:00Z');
const OLD = new Date('2024-06-01T00:00:00Z'); // > 24 months before NOW
const RECENT = new Date('2026-01-01T00:00:00Z');

function facts(over = {}) {
  return {
    companyId: 'c1',
    name: 'Acme Sales',
    createdAt: OLD,
    everWon: false,
    livePermission: false,
    contactData: true,
    relationContacts: [OLD],
    lastLetterAt: null,
    lastInquiryAt: null,
    ...over,
  };
}

test('the window is the letters\' own constant, imported rather than copied', () => {
  assert.equal(PROSPECT_RETENTION_MONTHS, templates.PROSPECT_RETENTION_MONTHS);
  assert.equal(prospectRetentionCutoff(NOW).toISOString(), '2024-11-13T12:00:00.000Z');
});

test('an old prospect with contact data is listed', () => {
  const v = judgeProspect(facts(), NOW);
  assert.equal(v.listed, true);
  assert.equal(v.lastContactAt.getTime(), OLD.getTime());
});

test('customer history excludes it — through the shared ever-won helper', () => {
  // At DEAL_WON now, or a stage history move into it: both count.
  const won = recordsEverWon(
    [
      { id: 'r-now', pipelineStatus: WON_STAGE_KEY },
      { id: 'r-hist', pipelineStatus: 'DEAL_LOST' },
      { id: 'r-never', pipelineStatus: 'NEW_LEAD' },
    ],
    ['r-hist'],
  );
  assert.deepEqual([...won].sort(), ['r-hist', 'r-now']);
  assert.deepEqual(wonHistoryWhere(['a', 'b']), { relationId: { in: ['a', 'b'] }, toStatus: WON_STAGE_KEY });
  assert.deepEqual(judgeProspect(facts({ everWon: won.has('r-hist') }), NOW), { listed: false, reason: 'customer', lastContactAt: null });
  assert.equal(judgeProspect(facts({ everWon: won.has('r-never') }), NOW).listed, true);
});

test('a live permission excludes it; a revoked, NONE, reply-only or erased-subject one does not', () => {
  assert.equal(hasLivePermission([{ basis: 'DOI_CONFIRMED', revokedAt: null }]), true);
  assert.equal(hasLivePermission([{ basis: 'EXISTING_CUSTOMER_7_3', revokedAt: null }]), true);
  assert.equal(hasLivePermission([{ basis: 'DOI_CONFIRMED', revokedAt: OLD }]), false);
  assert.equal(hasLivePermission([{ basis: 'NONE', revokedAt: null }]), false);
  assert.equal(hasLivePermission([{ basis: 'INQUIRY_REPLY', revokedAt: null }]), false);
  assert.equal(hasLivePermission([{ basis: 'DOI_CONFIRMED', revokedAt: null, subjectErasedAt: OLD }]), false);
  assert.equal(hasLivePermission([]), false);
  assert.equal(judgeProspect(facts({ livePermission: true }), NOW).reason, 'permission');
});

test('a recent contact through EACH of the three signals keeps it off the list', () => {
  const viaRelation = judgeProspect(facts({ relationContacts: [OLD, null, RECENT] }), NOW);
  const viaLetter = judgeProspect(facts({ lastLetterAt: RECENT }), NOW);
  const viaInquiry = judgeProspect(facts({ lastInquiryAt: RECENT }), NOW);
  for (const v of [viaRelation, viaLetter, viaInquiry]) {
    assert.equal(v.listed, false);
    assert.equal(v.reason, 'recent');
    assert.equal(v.lastContactAt.getTime(), RECENT.getTime());
  }
});

test('last contact is the newest signal; with none, the creation date', () => {
  assert.equal(prospectLastContact(facts({ relationContacts: [], lastLetterAt: OLD, lastInquiryAt: RECENT })).getTime(), RECENT.getTime());
  const created = new Date('2023-01-01T00:00:00Z');
  assert.equal(prospectLastContact(facts({ createdAt: created, relationContacts: [null] })).getTime(), created.getTime());
  // A never-contacted account created recently is not listed yet.
  assert.equal(judgeProspect(facts({ createdAt: RECENT, relationContacts: [] }), NOW).reason, 'recent');
});

test('an account already erased leaves the list', () => {
  const empty = { contactEmail: null, contactName: null, contactPhone: null, contactPosition: null };
  assert.equal(hasContactData({ company: empty, liveLetterSnapshots: 0, liveInquiries: 0 }), false);
  assert.equal(hasContactData({ company: { ...empty, contactPhone: '+49 30 1' }, liveLetterSnapshots: 0, liveInquiries: 0 }), true);
  assert.equal(hasContactData({ company: empty, liveLetterSnapshots: 1, liveInquiries: 0 }), true);
  assert.equal(hasContactData({ company: empty, liveLetterSnapshots: 0, liveInquiries: 1 }), true);
  assert.equal(hasContactData({ company: empty, liveLetterSnapshots: 0, addressBookEntries: 2, liveInquiries: 0 }), true);
  assert.equal(judgeProspect(facts({ contactData: false }), NOW).reason, 'erased');
});

test('only the sales-surface vertical has prospects', () => {
  assert.equal(prospectRetentionApplies(['pipeline']), true);
  assert.equal(prospectRetentionApplies(['pipeline', 'mentorship']), false);
  assert.equal(prospectRetentionApplies(['mentorship']), false);
  assert.equal(prospectRetentionApplies([]), false);
});

test('the list is longest-silent first, capped, and counts every overdue account', () => {
  const accounts = Array.from({ length: PROSPECT_REVIEW_LIMIT + 5 }, (_, i) =>
    facts({ companyId: `c${String(i).padStart(3, '0')}`, relationContacts: [new Date(Date.UTC(2023, 0, 1 + i))] }),
  );
  accounts.push(facts({ companyId: 'fresh', relationContacts: [RECENT] }));
  accounts.push(facts({ companyId: 'won', everWon: true }));
  const { total, items } = overdueProspects(accounts, NOW);
  assert.equal(total, PROSPECT_REVIEW_LIMIT + 5);
  assert.equal(items.length, PROSPECT_REVIEW_LIMIT);
  assert.equal(items[0].companyId, 'c000');
  assert.ok(!items.some((r) => r.companyId === 'fresh' || r.companyId === 'won'));
  // A row carries the name and the date only.
  assert.deepEqual(Object.keys(items[0]).sort(), ['companyId', 'lastContactAt', 'name']);
});

test('the letter snapshot of an erased prospect keeps nothing of the person', () => {
  assert.deepEqual(letterSnapshotErasureData(), { recipientName: null, addressBlock: ERASED_ADDRESS_BLOCK });
});
