// Slack Huddle links (#2879). Dependency-free and client-safe.
//
// Slack has no public API to start or join a huddle, but every channel and DM
// has a STABLE huddle link:
//
//   https://app.slack.com/huddle/<TEAM_ID>/<CHANNEL_ID>
//
// Opening it joins the huddle running in that channel, or starts one. That is
// the whole integration surface, and it makes a huddle a bring-your-own
// meeting link (#2007) like a Zoom or Meet room — not a provider or room type
// of its own. This module only knows the shape of that link: the UI reads
// `meetingProviderName()` (src/lib/meetingLink.ts) to label it, the Slack
// notification (PR 2) reads `parseHuddleUrl()` to pick a "Join Huddle" button.
//
// Only workspace MEMBERS can join a huddle. A mentee or an external guest who
// is not in the Slack workspace needs a built-in room instead — the docs say
// so (docs/video-calls-jaas.md § Slack Huddle link).

export const SLACK_HUDDLE_HOST = 'app.slack.com';

// Slack ids: a team id starts with T, a conversation id with C (channel),
// D (direct message) or G (private channel / group DM). Slack guarantees
// neither length nor alphabet beyond "upper-case alphanumerics", so the
// floor of six characters is a sanity bound, not a spec — real ids are 9–11.
const TEAM_ID = /^T[A-Z0-9]{6,}$/;
const CHANNEL_ID = /^[CDG][A-Z0-9]{6,}$/;

export interface SlackHuddleRef {
  /** `T…` */
  teamId: string;
  /** `C…` / `D…` / `G…` */
  channelId: string;
}

export function isSlackTeamId(value: unknown): value is string {
  return typeof value === 'string' && TEAM_ID.test(value);
}

export function isSlackChannelId(value: unknown): value is string {
  return typeof value === 'string' && CHANNEL_ID.test(value);
}

/**
 * The huddle link of a channel, or `null` when either id is not one. Strict
 * on purpose: the result is a link we send people to, and a malformed id
 * would make a link that opens Slack and shows nothing.
 */
export function buildHuddleUrl(teamId: string, channelId: string): string | null {
  if (!isSlackTeamId(teamId) || !isSlackChannelId(channelId)) return null;
  return `https://${SLACK_HUDDLE_HOST}/huddle/${teamId}/${channelId}`;
}

/**
 * The two ids out of a huddle link, or `null` for anything else — a Slack
 * message permalink, a `slack.com` marketing page, an http link, a link with
 * a third path segment. Case-insensitive on the host, exact on the ids (Slack
 * ids are upper-case). A trailing slash and a query string are tolerated,
 * because that is how a link survives being copied through a chat client.
 */
export function parseHuddleUrl(link: string | null | undefined): SlackHuddleRef | null {
  if (!link) return null;
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.hostname.toLowerCase() !== SLACK_HUDDLE_HOST) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length !== 3 || parts[0] !== 'huddle') return null;
  const [, teamId, channelId] = parts;
  if (!isSlackTeamId(teamId) || !isSlackChannelId(channelId)) return null;
  return { teamId, channelId };
}

/** True when the link is a huddle link — `parseHuddleUrl` as a predicate. */
export function isSlackHuddleLink(link: string | null | undefined): boolean {
  return parseHuddleUrl(link) !== null;
}
