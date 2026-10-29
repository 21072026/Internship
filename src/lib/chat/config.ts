import type { ChatPlatform } from '@prisma/client';

// Configured vs ENABLED, the Google Calendar discipline (docs/chat-apps.md
// § Environment variables): credentials can sit in an env for days of trial
// installs before anybody wants a real notification landing in a customer's
// workspace. Nothing is delivered unless CHAT_APPS_ENABLED=1 as well.

export function isChatPlatformConfigured(platform: ChatPlatform): boolean {
  if (platform === 'SLACK') {
    return Boolean(process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET && process.env.SLACK_SIGNING_SECRET);
  }
  return Boolean(process.env.TEAMS_APP_ID && process.env.TEAMS_APP_PASSWORD);
}

/** The deployment-wide switch. Per-workspace switching is ChatWorkspace.enabled. */
export function isChatAppsEnabled(): boolean {
  return process.env.CHAT_APPS_ENABLED === '1';
}

/** Installs are offered only when the platform is configured AND chat is switched on. */
export function isChatPlatformEnabled(platform: ChatPlatform): boolean {
  return isChatAppsEnabled() && isChatPlatformConfigured(platform);
}

/** URL path segment ↔ platform. Anything else is not a platform (404). */
export function platformFromSlug(slug: string): ChatPlatform | null {
  return slug === 'slack' ? 'SLACK' : slug === 'teams' ? 'TEAMS' : null;
}

/**
 * The ONE redirect URI registered with each platform: CHAT_OAUTH_REDIRECT_URI
 * (with `<platform>` substituted) or `<NEXTAUTH_URL>/api/integrations/chat/<p>/callback`
 * — the same derivation googleRedirectUri() uses. An IdP-registered endpoint
 * cannot follow the request host by nature (CLAUDE.md § served hosts).
 */
export function chatRedirectUri(platform: ChatPlatform): string | null {
  const slug = platform === 'SLACK' ? 'slack' : 'teams';
  const override = process.env.CHAT_OAUTH_REDIRECT_URI;
  if (override) return override.replace('<platform>', slug);
  const base = process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_APP_URL;
  return base ? `${base.replace(/\/$/, '')}/api/integrations/chat/${slug}/callback` : null;
}

// Endpoints from env WITH the real defaults, so the exchange is testable
// against a local stub (the googleCalendar.ts discipline). Env is operator
// configuration, never request input.
export function slackAuthorizeUrl(): string {
  return process.env.SLACK_OAUTH_AUTHORIZE_URL || 'https://slack.com/oauth/v2/authorize';
}
export function teamsLoginBase(): string {
  return (process.env.TEAMS_LOGIN_BASE || 'https://login.microsoftonline.com').replace(/\/$/, '');
}

/** The bot scopes the Slack install asks for (#1935) — nothing beyond what delivery needs. */
export const SLACK_BOT_SCOPES = ['chat:write', 'im:write', 'users:read', 'users:read.email', 'commands'] as const;
