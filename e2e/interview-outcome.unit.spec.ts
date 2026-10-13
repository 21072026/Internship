import { test, expect } from '@playwright/test';
import { INTERVIEW_OUTCOMES, isInterviewOutcome, outcomeMayAdvancePipeline, outcomeNotificationKey, outcomeTargetStage } from '@/lib/interviewOutcome';

// The interview outcome rule (#1846) — no browser, no database. Where a closed
// panel's decision moves the application is decided here, through the same
// transition table every other stage write obeys.

test('a decision moves the application along the funnel, never past it', { tag: '@smoke' }, async () => {
  expect([...INTERVIEW_OUTCOMES]).toEqual(['ADVANCE', 'REJECT', 'OFFER']);
  expect(isInterviewOutcome('OFFER') && !isInterviewOutcome('HIRE')).toBe(true);
  // ADVANCE: the next OPEN stage.
  expect(outcomeTargetStage('ADVANCE', 'SHORTLISTED')).toBe('INTERVIEW');
  expect(outcomeTargetStage('ADVANCE', 'INTERVIEW')).toBe('OFFER');
  // The hire is the offer flow's job, so an application already at OFFER has no next open stage.
  expect(outcomeTargetStage('ADVANCE', 'OFFER')).toBeNull();
  expect(outcomeTargetStage('ADVANCE', 'REJECTED')).toBeNull();
  // OFFER needs an interview first.
  expect(outcomeTargetStage('OFFER', 'INTERVIEW')).toBe('OFFER');
  expect(outcomeTargetStage('OFFER', 'SHORTLISTED')).toBeNull();
  // REJECT from any open stage, never from a terminal one.
  expect(outcomeTargetStage('REJECT', 'INTERVIEW')).toBe('REJECTED');
  expect(outcomeTargetStage('REJECT', 'HIRED')).toBeNull();
});

test('a rejection never moves the programme pipeline; the company hears a decision, not a score', async () => {
  expect(outcomeMayAdvancePipeline('REJECT')).toBe(false);
  expect(outcomeMayAdvancePipeline('ADVANCE')).toBe(true);
  expect(outcomeMayAdvancePipeline('OFFER')).toBe(true);
  expect(outcomeNotificationKey('OFFER')).toBe('interview_panel.outcome.offer');
});
