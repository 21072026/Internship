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
