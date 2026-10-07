import { test, expect } from '@playwright/test';
import { canPerformApplicationAction, canTransition } from '@/lib/applications';

// The application state machine (#1828) — the rule alone, no browser and no
// database. The legal path is enforced by canTransition, never by a screen, so
// the one assertion the issue asks for lives where a UI change cannot hide it.

test('an application cannot jump from APPLIED to HIRED', { tag: '@smoke' }, async () => {
  expect(canTransition('APPLIED', 'HIRED')).toBe(false);
  expect(canTransition('APPLIED', 'SCREENING')).toBe(true);
  expect(canTransition('OFFER', 'HIRED')).toBe(true);
  expect(canTransition('HIRED', 'APPLIED')).toBe(false);
});

test('a company may only touch applications to its own requisition, a mentee may only withdraw', { tag: '@smoke' }, async () => {
  expect(canPerformApplicationAction({ role: 'COMPANY', isOwnApplication: false, isOwningCompany: false, from: 'APPLIED', to: 'SHORTLISTED' })).toBe(false);
  expect(canPerformApplicationAction({ role: 'COMPANY', isOwnApplication: false, isOwningCompany: true, from: 'APPLIED', to: 'SHORTLISTED' })).toBe(true);
  expect(canPerformApplicationAction({ role: 'COMPANY', isOwnApplication: false, isOwningCompany: true, from: 'OFFER', to: 'HIRED' })).toBe(false);
  expect(canPerformApplicationAction({ role: 'MENTEE', isOwnApplication: true, isOwningCompany: false, from: 'APPLIED', to: 'WITHDRAWN' })).toBe(true);
  expect(canPerformApplicationAction({ role: 'MENTEE', isOwnApplication: true, isOwningCompany: false, from: 'APPLIED', to: 'SHORTLISTED' })).toBe(false);
});
