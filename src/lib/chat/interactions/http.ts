import { NextResponse, after } from 'next/server';
import { createHash } from 'crypto';
import { logger } from '@/lib/logger';
import { rateLimit } from '@/lib/rateLimit';
import { verifySlackSignature } from '@/lib/chat/slackSignature';
import { verifyBotFrameworkRequest } from '@/lib/chat/botFrameworkAuth';
import { assertPublicHttpsUrl } from '@/lib/ssrfGuard';
import { dispatchInteraction, parseSlackInteraction, parseTeamsInteraction, isSlackResponseUrl, type ChatReply } from './index';

// The HTTP half of the chat interaction endpoint (#1948). Both platforms, in
// the order the issue pins and nothing in between:
//
//   1. the raw body, read ONCE (request.text()) — a signature over a
//      re-serialised object is not a signature;
//   2. the platform's signature (Slack v0 HMAC / Bot Framework JWT);
//   3. the replay window (Slack: ±5 min, and a signature is accepted once);
//   4. the rate limit, per (workspace, member);
//   5. only then the envelope is parsed and dispatched.
//
// Every refusal of 1–3 is the same opaque 401 — a caller is never told which
// check failed. (Teams' JWT is bound to the activity's serviceUrl, so the body
// is JSON-decoded to read that one field before the check; nothing else of it
// is looked at, and no database is touched, until the token verifies.)
//
// THE RATE LIMIT AND THE REPLAY MEMORY ARE src/lib/rateLimit.ts: in-memory and
// per process unless RATE_LIMIT_REDIS_URL is set — one of the known
// single-replica constraints (#1668/#1673 own the shared store).
//
// The 3-second budget: Slack is acknowledged at once and the work runs after
// the response (`after()`), its reply posted to the interaction's
// response_url as an ephemeral message. A Teams Universal Action is answered
// in the invoke response itself, which is how Teams expects it.

const UNAUTHORIZED = () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
const PER_MEMBER = { limit: 30, windowMs: 60_000 };
const SLACK_REPLAY_WINDOW_MS = 10 * 60_000;

function memberLimited(platform: string, teamId: string, member: string): boolean {
  return !rateLimit(`chat-interaction:${platform}:${teamId}:${member}`, PER_MEMBER).ok;
}

function allowInsecureResponseUrl(): boolean {
  return process.env.CHAT_RESPONSE_URL_ALLOW_INSECURE_STUB === '1';
}

/** Slack's reply: an ephemeral message on the interaction's response_url, which must be Slack's own host. */
async function postSlackReply(responseUrl: string | null, reply: ChatReply): Promise<void> {
  const insecure = allowInsecureResponseUrl();
  if (!isSlackResponseUrl(responseUrl, insecure)) {
    logger.warning('chat interaction reply dropped', { reason: 'response_url' });
    return;
  }
  try {
    // Re-checked at send time like every outbound call (src/lib/webhooks.ts):
    // the host allowlist above plus the SSRF guard's resolution check. The
    // loopback e2e sink is the one exception and only behind its switch.
    if (!insecure) await assertPublicHttpsUrl(responseUrl as string);
    const res = await fetch(responseUrl as string, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ response_type: 'ephemeral', replace_original: false, text: reply.text }),
      signal: AbortSignal.timeout(5_000),
      redirect: 'error',
    });
    if (!res.ok) logger.warning('chat interaction reply refused', { status: res.status });
  } catch (e) {
    logger.warning('chat interaction reply failed', { error: String(e) });
  }
}

export async function slackInteraction(request: Request): Promise<NextResponse> {
  const rawBody = await request.text();
  const signature = request.headers.get('x-slack-signature');
  const ok = verifySlackSignature({
    secret: process.env.SLACK_SIGNING_SECRET,
    timestamp: request.headers.get('x-slack-request-timestamp'),
    signature,
    rawBody,
  });
  if (!ok || !signature) return UNAUTHORIZED();
  // A captured request replayed inside the window carries the same signature:
  // the first one is the only one. Keyed by a hash, never the signature itself.
  const sigKey = createHash('sha256').update(signature).digest('hex').slice(0, 32);
  if (!rateLimit(`chat-interaction-sig:${sigKey}`, { limit: 1, windowMs: SLACK_REPLAY_WINDOW_MS }).ok) return UNAUTHORIZED();

  const env = parseSlackInteraction(rawBody);
  // Not an interaction we take (a view submission, a shortcut, …): Slack wants a 200.
  if (!env) return NextResponse.json({ ok: true, ignored: true });
  if (memberLimited('slack', env.teamId, env.externalUserId)) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429, headers: { 'Retry-After': '60' } });
  }
  after(async () => {
    const outcome = await dispatchInteraction('SLACK', env);
    await postSlackReply(env.responseUrl, outcome.reply);
  });
  // An empty 200 is Slack's acknowledgement; the reply follows on response_url.
  return new NextResponse(null, { status: 200 });
}

/** A verified Teams activity that is a Universal Action. The caller has already checked the JWT. */
export async function teamsVerifiedInteraction(activity: unknown): Promise<NextResponse> {
  const env = parseTeamsInteraction(activity);
  if (!env) return NextResponse.json({ ok: true, ignored: true });
  if (memberLimited('teams', env.teamId, env.externalUserId)) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429, headers: { 'Retry-After': '60' } });
  }
  const outcome = await dispatchInteraction('TEAMS', env);
  // The Universal Action invoke response: a message shown to the clicker.
  return NextResponse.json({ statusCode: 200, type: 'application/vnd.microsoft.activity.message', value: outcome.reply.text });
}

export async function teamsInteraction(request: Request): Promise<NextResponse> {
  const rawBody = await request.text();
  let activity: { serviceUrl?: unknown } | null;
  try {
    activity = JSON.parse(rawBody);
  } catch {
    return UNAUTHORIZED();
  }
  const auth = await verifyBotFrameworkRequest({
    authorization: request.headers.get('authorization'),
    serviceUrl: typeof activity?.serviceUrl === 'string' ? activity.serviceUrl : null,
  });
  if (!auth.ok) return UNAUTHORIZED();
  return teamsVerifiedInteraction(activity);
}
