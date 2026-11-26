// Unit tests for the notification-mail report (prisma/diagnose-notification-mail.mjs).
// It prints into a public deploy log, so the one thing that must hold is that
// no address reaches a line, and that every stage is reported even when empty.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reasonOf, formatCounts, mailReport, EVENTS } from '../../prisma/diagnose-notification-mail.mjs';

test('a stored error is reduced to a short reason with no address', () => {
  assert.equal(reasonOf(null), '-');
  assert.equal(reasonOf('Unsubscribed: mentorship_lifecycle'), 'Unsubscribed: mentorship_lifecycle');
  assert.equal(reasonOf('550 5.1.1 <rep@shop.example>: Recipient address rejected (mailbox full)'), '550 5.1.1 <[email]>: Recipient');
  assert.ok(!reasonOf('SMTP said no to someone@acme.example today').includes('@acme'));
});

test('the report names every event, channel and stage, empty or not', () => {
  const now = new Date('2026-11-26T12:00:00Z');
  const lines = mailReport({
    days: 14,
    deliveries: [{ eventKey: 'lead.handedOff', channel: 'email', status: 'SKIPPED', skipReason: 'stale', n: 4 }],
    jobs: [{ eventKey: 'lead.handedOff', status: 'PENDING', n: 2 }],
    oldestPending: { 'lead.handedOff': new Date('2026-11-26T09:00:00Z') },
    emailLogs: [],
    lastJobFinished: new Date('2026-11-26T11:55:00Z'),
    overdueJobs: 7,
    now,
  });
  const text = lines.join('\n');
  for (const e of EVENTS) assert.ok(text.includes(`delivery ${e} email`) && text.includes(`delivery ${e} inApp`), e);
  assert.ok(text.includes('delivery lead.handedOff email: SKIPPED[stale]=4'));
  assert.ok(text.includes('job notification.email lead.handedOff: PENDING=2 oldestPending=180m'));
  assert.ok(text.includes('email log mentee-assigned: none'));
  assert.ok(text.includes('job worker: lastFinished=5m ago, overdueOver10m=7'));
  assert.equal(formatCounts([], () => 'x'), 'none');
});
