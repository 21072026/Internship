import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import {
  buildDeadLetterAlert,
  normalizeReason,
  MAX_ROWS_SHOWN,
  type DeadLetterSummary,
} from '@/lib/jobs/dlqAlertMessage';

// The dead-letter alert's two promises (#1674), tested without a database, a
// mail transport or a browser:
//
//   1. It is SILENT when the queue is clean. That is the property the whole
//      convention rests on, and it is one `null` return — easy to break by
//      accident, invisible until somebody starts ignoring the alert.
//   2. What it says is bounded and safe: counts, an age, job type names and
//      grouped failure reasons — never a payload, never an address, never a
//      row-by-row dump.
//
// The route-shape test at the bottom guards the *other* half of the issue: the
// counters must cost an anonymous caller nothing.

const empty: DeadLetterSummary = {
  total: 0,
  oldestAt: null,
  byName: [],
  reasons: [],
  reasonsSampledFrom: 0,
};

function summary(over: Partial<DeadLetterSummary> = {}): DeadLetterSummary {
  return {
    total: 3,
    oldestAt: '2026-09-01T06:15:00.000Z',
    byName: [
      { name: 'email.send', count: 2, lastFailedAt: '2026-09-05T21:00:00.000Z' },
      { name: 'report.weekly', count: 1, lastFailedAt: '2026-09-04T09:30:00.000Z' },
    ],
    reasons: [
      { reason: 'Connection refused', count: 2 },
      { reason: 'ETIMEDOUT', count: 1 },
    ],
    reasonsSampledFrom: 3,
    ...over,
  };
}

test('an empty dead-letter queue produces no message at all', () => {
  expect(buildDeadLetterAlert(empty)).toBeNull();
  // Defensive: a count that somehow went negative is still "nothing to report",
  // not a mail claiming -1 jobs are waiting.
  expect(buildDeadLetterAlert({ ...empty, total: -1 })).toBeNull();
});

test('a non-empty queue produces one message naming each job type and count', () => {
  const message = buildDeadLetterAlert(summary());
  expect(message).not.toBeNull();
  expect(message!.subject).toBe('[CRM] Ölü mektup kuyruğunda 3 iş bekliyor');
  const html = message!.html;
  // How many, since when…
  expect(html).toContain('<b>3</b>');
  expect(html).toContain('1 Eyl 2026');
  // …which job types, with their counts…
  expect(html).toContain('email.send');
  expect(html).toContain('report.weekly');
  // …and the distinct failure reasons with counts.
  expect(html).toContain('<b>2×</b> Connection refused');
  expect(html).toContain('<b>1×</b> ETIMEDOUT');
  // The sample note only appears when the histogram really is a sample.
  expect(html).not.toContain('kayıt üzerinden');
});

test('the reason histogram says so when it is only a sample', () => {
  const html = buildDeadLetterAlert(summary({ total: 900, reasonsSampledFrom: 200 }))!.html;
  expect(html).toContain('en son 200 kayıt üzerinden');
});

test('long lists are truncated with a tail instead of dumped', () => {
  const many = Array.from({ length: MAX_ROWS_SHOWN + 4 }, (_, i) => ({
    name: `job.type${i}`,
    count: 1,
    lastFailedAt: null,
  }));
  const html = buildDeadLetterAlert(summary({ total: many.length, byName: many }))!.html;
  expect(html).toContain(`job.type${MAX_ROWS_SHOWN - 1}`);
  expect(html).not.toContain(`job.type${MAX_ROWS_SHOWN}`);
  expect(html).toContain('… ve 4 tür daha');
});

test('a job name or reason cannot inject markup into the mail', () => {
  const html = buildDeadLetterAlert(
    summary({
      byName: [{ name: '<script>x</script>', count: 1, lastFailedAt: null }],
      reasons: [{ reason: 'boom "&" <b>bold</b>', count: 1 }],
    })
  )!.html;
  expect(html).not.toContain('<script>');
  expect(html).toContain('&lt;script&gt;');
  expect(html).toContain('&lt;b&gt;bold&lt;/b&gt;');
});

test('a failure reason is sanitised, single-line and bounded', () => {
  // The shared sanitiser is what keeps an SMTP rejection from carrying the
  // recipient into an operator mailbox.
  expect(normalizeReason('550 rejected for someone@example.com')).toContain('<redacted>');
  expect(normalizeReason('550 rejected for someone@example.com')).not.toContain('example.com');
  // Only the first line: a stack trace differs on every row and would defeat
  // the grouping.
  expect(normalizeReason('Boom\n    at handler (foo.ts:1:1)')).toBe('Boom');
  expect(normalizeReason(null)).toBe('bilinmeyen hata');
  expect(normalizeReason('   ')).toBe('bilinmeyen hata');
  expect(normalizeReason('x'.repeat(400)).length).toBeLessThanOrEqual(120);
});

// The counters are cheap only as long as nothing calls them on the anonymous
// path. That is a property of the route's *shape*, not of any response, so it
// is read out of the source — the same trick e2e/email-groups-footer.unit.spec.ts
// uses. /api/health is in the nightly k6 anonymous-GET mix with a latency
// budget; a stray call up here would be paid by every uptime probe.
test('the queue counters are read only behind the detail gate and ?jobs=1', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src/app/api/health/route.ts'), 'utf8');

  // Exactly one call site, and it is opt-in.
  const calls = src.match(/jobQueueHealth\(\)/g) ?? [];
  expect(calls).toHaveLength(1);
  expect(src).toContain("params.get('jobs') === '1'");
  expect(src).toContain('...(wantsJobs ? { jobs: await jobQueueHealth() } : {})');

  // …and it sits after the anonymous early return, so an unauthorised caller
  // never reaches it.
  const anonymousReturn = src.indexOf('if (!(await maySeeDetail(request)))');
  expect(anonymousReturn).toBeGreaterThan(0);
  expect(src.indexOf('await jobQueueHealth()')).toBeGreaterThan(anonymousReturn);

  // The fields the deploy gate and the uptime probes parse are still produced
  // the way they were — `sha` above all, which infra/deploy-prod.sh reads to
  // decide whether the live container has drifted.
  expect(src).toContain('sha: GIT_SHA');
  expect(src).toContain('version: APP_VERSION');
  expect(src).toContain('responseMs: Date.now() - started');
});
