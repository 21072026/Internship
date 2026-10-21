import { test, expect } from '@playwright/test';
import { canDecideStep, canInviteExternal, chainFor, documentSatisfies, isSatisfied, nextStep, parseReviewerSteps, validityWindow } from '@/lib/documentReview';

// The document review chain's pure rules (#1859): what "satisfied" means per
// mode, the step order, and who may decide which step.

const now = new Date('2026-10-20T12:00:00Z');
const past = new Date('2026-10-01T00:00:00Z');
const future = new Date('2026-12-01T00:00:00Z');

test('NONE keeps "a file attached is done"; a chain needs APPROVED; an expired file never counts', { tag: '@smoke' }, async () => {
  // NONE: a document still PENDING (pre-backfill) satisfies, exactly as before the column existed.
  expect(documentSatisfies('NONE', { reviewStatus: 'PENDING', validUntil: null }, now)).toBe(true);
  expect(documentSatisfies('NONE', { reviewStatus: 'APPROVED', validUntil: null }, now)).toBe(true);
  expect(documentSatisfies('NONE', { reviewStatus: 'EXPIRED', validUntil: past }, now)).toBe(false);
  for (const mode of ['SINGLE', 'CHAIN']) {
    expect(documentSatisfies(mode, { reviewStatus: 'PENDING', validUntil: null }, now)).toBe(false);
    expect(documentSatisfies(mode, { reviewStatus: 'REJECTED', validUntil: null }, now)).toBe(false);
    expect(documentSatisfies(mode, { reviewStatus: 'APPROVED', validUntil: future }, now)).toBe(true);
    expect(documentSatisfies(mode, { reviewStatus: 'APPROVED', validUntil: past }, now)).toBe(false);
  }
  expect(isSatisfied({ approvalMode: 'CHAIN' }, [{ reviewStatus: 'REJECTED', validUntil: null }, { reviewStatus: 'APPROVED', validUntil: null }], now)).toBe(true);
  expect(isSatisfied({ approvalMode: 'CHAIN' }, [], now)).toBe(false);
});

test('steps are ordered, renumbered and decided lowest-first; a rejection ends the chain', { tag: '@smoke' }, async () => {
  expect(parseReviewerSteps([{ step: 3, role: 'EXTERNAL' }, { step: 1, role: 'MENTOR', label: ' Supervisor ' }, { role: 'BOSS' }])).toEqual([
    { step: 1, role: 'MENTOR', label: 'Supervisor' },
    { step: 2, role: 'EXTERNAL' },
  ]);
  expect(parseReviewerSteps('nope')).toBeNull();
  expect(chainFor({ approvalMode: 'NONE', reviewerRoles: [{ role: 'ADMIN' }] })).toEqual([]);
  expect(chainFor({ approvalMode: 'CHAIN', reviewerRoles: [] })).toEqual([{ step: 1, role: 'ADMIN' }]);
  expect(chainFor({ approvalMode: 'SINGLE', reviewerRoles: [{ role: 'MENTOR' }, { role: 'ADMIN' }] })).toEqual([{ step: 1, role: 'MENTOR' }]);
  expect(nextStep([{ step: 2, decision: null }, { step: 1, decision: null }])?.step).toBe(1);
  expect(nextStep([{ step: 1, decision: 'APPROVED' }, { step: 2, decision: null }])?.step).toBe(2);
  expect(nextStep([{ step: 1, decision: 'REJECTED' }, { step: 2, decision: null }])).toBeNull();
  expect(nextStep([{ step: 1, decision: 'APPROVED' }])).toBeNull();
  expect(validityWindow(30, now).validUntil?.toISOString()).toBe('2026-11-19T12:00:00.000Z');
  expect(validityWindow(null, now).validUntil).toBeNull();
});

test('nobody approves their own document; an EXTERNAL step is never a signed-in decision', { tag: '@smoke' }, async () => {
  const base = { isOwnersActiveMentor: false, isOwnersCompany: false, isOwner: false };
  expect(canDecideStep({ ...base, stepRole: 'ADMIN', actorRole: 'ADMIN' })).toBe(true);
  expect(canDecideStep({ ...base, stepRole: 'ADMIN', actorRole: 'ADMIN', isOwner: true })).toBe(false);
  expect(canDecideStep({ ...base, stepRole: 'MENTOR', actorRole: 'MENTOR' })).toBe(false);
  expect(canDecideStep({ ...base, stepRole: 'MENTOR', actorRole: 'MENTOR', isOwnersActiveMentor: true })).toBe(true);
  expect(canDecideStep({ ...base, stepRole: 'MENTOR', actorRole: 'ADMIN' })).toBe(false);
  expect(canDecideStep({ ...base, stepRole: 'COMPANY', actorRole: 'COMPANY', isOwnersCompany: true })).toBe(true);
  expect(canDecideStep({ ...base, stepRole: 'EXTERNAL', actorRole: 'ADMIN' })).toBe(false);
  expect(canInviteExternal({ actorRole: 'ADMIN', isOwnersActiveMentor: false, isOwner: false })).toBe(true);
  expect(canInviteExternal({ actorRole: 'MENTEE', isOwnersActiveMentor: false, isOwner: true })).toBe(false);
  expect(canInviteExternal({ actorRole: 'MENTOR', isOwnersActiveMentor: false, isOwner: false })).toBe(false);
});
