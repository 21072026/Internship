import { test, expect } from '@playwright/test';
import {
  browserSummary,
  buildIssueDraft,
  githubConfig,
  isIssueUrlOf,
  isSlackWebhookUrl,
  notifyChannels,
  pathOnly,
} from '../src/lib/supportReportIntegrationRule';
import { OUTBOUND_CATEGORIES } from '../src/lib/outboundApprovalRule';
import { groupForCategory } from '../src/lib/emailGroups';

// Phase 3 of the bug reports (#3132): the notification channel switch, the
// GitHub configuration, and — the load-bearing one — that an issue draft never
// carries the reporter, their words or a tenant's host.

test.describe('support report integrations', { tag: '@smoke' }, () => {
  test('the notification channel is e-mail unless configured otherwise', () => {
    const hook = 'https://hooks.slack.com/services/T000/B000/abcdefghijkl';
    expect(notifyChannels({})).toEqual(['email']);
    expect(notifyChannels({ SUPPORT_REPORT_NOTIFY: 'off' })).toEqual([]);
    expect(notifyChannels({ SUPPORT_REPORT_NOTIFY: 'slack', SUPPORT_REPORT_SLACK_WEBHOOK_URL: hook })).toEqual(['slack']);
    expect(notifyChannels({ SUPPORT_REPORT_NOTIFY: 'both', SUPPORT_REPORT_SLACK_WEBHOOK_URL: hook })).toEqual(['email', 'slack']);
    // Slack without a usable webhook falls back to e-mail, never to silence.
    expect(notifyChannels({ SUPPORT_REPORT_NOTIFY: 'slack' })).toEqual(['email']);
    expect(notifyChannels({ SUPPORT_REPORT_NOTIFY: 'slack', SUPPORT_REPORT_SLACK_WEBHOOK_URL: 'https://evil.example/hook' })).toEqual(['email']);
    expect(isSlackWebhookUrl('http://hooks.slack.com/services/T/B/x1234567890')).toBe(false);
  });

  test('GitHub is configured only with a well-formed repo and a token', () => {
    expect(githubConfig({})).toBeNull();
    expect(githubConfig({ SUPPORT_GITHUB_REPO: 'example-org/example-repo' })).toBeNull();
    expect(githubConfig({ SUPPORT_GITHUB_REPO: 'not a repo', SUPPORT_GITHUB_TOKEN: 't' })).toBeNull();
    expect(githubConfig({ SUPPORT_GITHUB_REPO: 'example-org/example-repo', SUPPORT_GITHUB_TOKEN: 't' })).toEqual({ repo: 'example-org/example-repo', token: 't' });
    expect(isIssueUrlOf('example-org/example-repo', 'https://github.com/example-org/example-repo/issues/12')).toBe(true);
    expect(isIssueUrlOf('example-org/example-repo', 'https://github.com/other/example-repo/issues/12')).toBe(false);
    expect(isIssueUrlOf('example-org/example-repo', 'https://github.com/example-org/example-repo/pull/12')).toBe(false);
  });

  test('an issue draft carries technical facts only — no reporter, no words, no host', () => {
    const draft = buildIssueDraft({
      id: 'rep123',
      type: 'BUG',
      url: 'https://tenant-brand.example/admin/candidates?q=***',
      appVersion: '0.437.0-beta (abc1234)',
      env: 'production',
      viewport: '1280x800',
      userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/152.0.0.0 Safari/537.36',
      createdAt: new Date('2026-10-23T08:15:00Z'),
      hasScreenshot: true,
      hasReplay: false,
      consoleCount: 2,
      failedRequests: [{ method: 'GET', url: 'https://tenant-brand.example/api/x?token=***', status: 500, requestId: 'req-9' }],
    });
    expect(draft.title).toBe('[Bug report] /admin/candidates');
    expect(draft.body).toContain('`/admin/candidates?q=***`');
    expect(draft.body).toContain('| GET | `/api/x?token=***` | 500 | `req-9` |');
    expect(draft.body).toContain('Chrome 152');
    expect(draft.body).toContain('`/admin/support/reports/rep123`');
    expect(draft.body).not.toContain('tenant-brand');
    expect(draft.body).not.toContain('Mozilla');
  });

  test('path and browser helpers', () => {
    expect(pathOnly('https://a.example/x/y?z=***#h')).toBe('/x/y?z=***');
    expect(pathOnly('/rel')).toBe('/rel');
    expect(browserSummary('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Version/17.0 Mobile/15E148 Safari/604.1')).toBe('Safari 17 (mobile)');
    expect(browserSummary('Mozilla/5.0 Firefox/131.0')).toBe('Firefox 131');
  });

  test('both new mail categories are registered with a group and an approval entry', () => {
    expect(groupForCategory('support-report')).toBe('inbound_requests');
    expect(groupForCategory('support-report-update')).toBe('direct_messages');
    expect(OUTBOUND_CATEGORIES['support-report']).toBeTruthy();
    // Held like the e-mail copy of a message, not exempt (scripts/test/outbound-approval-rule.test.mjs pins the exempt set).
    expect(OUTBOUND_CATEGORIES['support-report-update']).toMatchObject({ exempt: false, trigger: 'message' });
  });
});
