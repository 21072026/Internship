// Plain-ESM mirror of the CompanyInterest -> Application bridge in
// src/lib/applications.ts (#1828). The deploy backfill runs on the server with
// Node 20 and cannot import TypeScript, so the mapping lives here too;
// scripts/test/applications.test.mjs compares the two over a corpus — change
// one and the test tells you to change the other in the same commit.

export const INTEREST_STAGE = Object.freeze({
  INTERESTED: 'SCREENING',
  SHORTLISTED: 'SHORTLISTED',
  PASS: 'REJECTED',
});

const TERMINAL_STAGES = new Set(['HIRED', 'REJECTED', 'WITHDRAWN']);

export function statusForStage(stage) {
  return TERMINAL_STAGES.has(stage) ? stage : 'ACTIVE';
}

/** @returns the application seed for an interest with a requisition, else null. */
export function interestToApplication(interest) {
  if (!interest.requisitionId) return null;
  if (!Object.prototype.hasOwnProperty.call(INTEREST_STAGE, interest.status)) return null;
  const stage = INTEREST_STAGE[interest.status];
  const rejected = stage === 'REJECTED';
  const note = (interest.note ?? '').trim() || null;
  return {
    requisitionId: interest.requisitionId,
    menteeId: interest.menteeId,
    companyId: interest.companyId,
    source: 'SHORTLIST',
    stage,
    status: statusForStage(stage),
    dispositionCode: rejected ? 'OTHER' : null,
    dispositionNote: rejected ? note : null,
  };
}
