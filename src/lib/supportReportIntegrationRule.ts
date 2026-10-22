// Phase 3 of the in-app bug reports (#3132) — the pure rules: which channel a
// new report is announced on, whether GitHub issue creation is configured, and
// what an issue may say. Dependency-free and unit-tested
// (e2e/support-report-integrations.unit.spec.ts). Design: docs/feedback-reports.md § Phase 3.
//
// THE ISSUE BODY IS PUBLIC-SAFE BY CONSTRUCTION. The target repository may be
// public, and a report is about a real person on a real tenant. So the draft
// carries only technical facts — type, build, environment, the page PATH (never
// the host: a tenant's own domain is a tenant name), viewport, browser, counts,
// and the failed requests' method / path / status / request id — and a RELATIVE
// link to the admin detail. Never the description, the reporter, an e-mail
// address, a console message, the screenshot or the replay. An admin reads the
// draft before it is sent and may add to it; what they add is theirs.

export type NotifyChannel = 'email' | 'slack';

const SLACK_WEBHOOK = /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{10,200}$/;

export function isSlackWebhookUrl(raw: string | undefined): boolean {
  return !!raw && SLACK_WEBHOOK.test(raw.trim());
}

/**
 * SUPPORT_REPORT_NOTIFY = `email` (default) | `slack` | `both` | `off`.
 * Slack needs a valid SUPPORT_REPORT_SLACK_WEBHOOK_URL; without one a `slack`
 * choice falls back to e-mail rather than announcing nothing.
 */
export function notifyChannels(env: Record<string, string | undefined>): NotifyChannel[] {
  const mode = (env.SUPPORT_REPORT_NOTIFY ?? 'email').trim().toLowerCase();
  const slackOk = isSlackWebhookUrl(env.SUPPORT_REPORT_SLACK_WEBHOOK_URL);
  if (mode === 'off') return [];
  if (mode === 'slack') return slackOk ? ['slack'] : ['email'];
  if (mode === 'both') return slackOk ? ['email', 'slack'] : ['email'];
  return ['email'];
}

const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

export interface GithubConfig {
  repo: string;
  token: string;
}

/** SUPPORT_GITHUB_REPO (`owner/name`) + SUPPORT_GITHUB_TOKEN, or null when either is missing. */
export function githubConfig(env: Record<string, string | undefined>): GithubConfig | null {
  const repo = (env.SUPPORT_GITHUB_REPO ?? '').trim();
  const token = (env.SUPPORT_GITHUB_TOKEN ?? '').trim();
  return REPO.test(repo) && token ? { repo, token } : null;
}

/** The only issue URL a report may store: an issue of the configured repository. */
export function isIssueUrlOf(repo: string, url: string): boolean {
  return new RegExp(`^https://github\\.com/${repo.replace(/[.]/g, '\\.')}/issues/\\d+$`).test(url);
}

export const ISSUE_TITLE_MAX = 200;
export const ISSUE_BODY_MAX = 20_000;
export const STATUS_NOTE_MAX = 1000;

export interface IssueSource {
  id: string;
  type: 'BUG' | 'FEEDBACK';
  url: string;
  appVersion: string;
  env: string;
  viewport: string;
  userAgent: string;
  createdAt: Date;
  hasScreenshot: boolean;
  hasReplay: boolean;
  consoleCount: number;
  failedRequests: { method: string; url: string; status: number; requestId?: string }[];
}

/** A URL's path + masked query, never its host. */
export function pathOnly(raw: string): string {
  if (!raw) return '';
  try {
    const u = new URL(raw, 'http://relative.invalid');
    return `${u.pathname}${u.search}`;
  } catch {
    return '';
  }
}

/** The browser family and major version, not the full user-agent string. */
export function browserSummary(ua: string): string {
  const pick = (re: RegExp, name: string) => {
    const m = ua.match(re);
    return m ? `${name} ${m[1]}` : null;
  };
  const family =
    pick(/Edg\/(\d+)/, 'Edge') ??
    pick(/Firefox\/(\d+)/, 'Firefox') ??
    pick(/Chrome\/(\d+)/, 'Chrome') ??
    pick(/Version\/(\d+)[\d.]* .*Safari/, 'Safari') ??
    'unknown';
  return family + (/\b(Android|iPhone|iPad)\b/.test(ua) ? ' (mobile)' : '');
}

/** The default issue draft — see the header for what it may and may not carry. */
export function buildIssueDraft(r: IssueSource): { title: string; body: string } {
  const kind = r.type === 'BUG' ? 'Bug report' : 'Feedback';
  const page = pathOnly(r.url) || '—';
  const title = `[${kind}] ${page.split('?')[0]}`.slice(0, ISSUE_TITLE_MAX);
  const lines = [
    `From the in-app feedback button (support report \`${r.id}\`).`,
    '',
    '| | |',
    '|---|---|',
    `| Type | ${kind} |`,
    `| Page | \`${page}\` |`,
    `| Build | \`${r.appVersion}\` · ${r.env} |`,
    `| Browser | ${browserSummary(r.userAgent)} · ${r.viewport || '—'} |`,
    `| Reported | ${r.createdAt.toISOString().slice(0, 16).replace('T', ' ')} UTC |`,
    `| Console errors | ${r.consoleCount} |`,
    `| Failed requests | ${r.failedRequests.length} |`,
    `| Screenshot / replay | ${r.hasScreenshot ? 'yes' : 'no'} / ${r.hasReplay ? 'yes' : 'no'} — in the admin detail |`,
  ];
  if (r.failedRequests.length) {
    lines.push('', '**Failed requests** (newest last)', '', '| Method | Path | Status | Request ID |', '|---|---|---|---|');
    for (const f of r.failedRequests.slice(-10)) {
      lines.push(`| ${f.method} | \`${pathOnly(f.url)}\` | ${f.status || 'network error'} | ${f.requestId ? `\`${f.requestId}\`` : '—'} |`);
    }
  }
  lines.push(
    '',
    `Details, screenshot and replay (admins only): \`/admin/support/reports/${r.id}\``,
    '',
    '<!-- The reporter, their description and console messages are deliberately not copied here. -->',
  );
  return { title, body: lines.join('\n').slice(0, ISSUE_BODY_MAX) };
}
