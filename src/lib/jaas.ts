import { createSign } from 'crypto';

// JaaS — "Jitsi as a Service", 8x8's hosted Jitsi (#1237).
//
// Why this exists at all: the public `meet.jit.si` instance allows being put in
// an iframe, but *disconnects an embedded call after five minutes* and says so
// in a banner ("Embedding meet.jit.si is only meant for demo purposes"). The
// side panel from #1054 is therefore unusable in production against that host.
// JaaS is the same software on our own tenant, addressed as
// `https://8x8.vc/<appId>/<room>`, and it wants a per-participant JWT signed
// with the RSA key we generated in the JaaS console.
//
// Server-only: the private key must never reach the browser. The client gets a
// short-lived token from GET /api/meetings/[id]/call-token and nothing else.
//
// Everything here degrades to `null` when the environment is not configured —
// that is the default in local dev, CI and every e2e run, and it keeps the old
// meet.jit.si behaviour (see src/lib/meetingRoom.ts) rather than breaking calls.

export const JAAS_HOST = '8x8.vc';

// App IDs handed out by the JaaS console all carry this prefix. Checking it is
// how we can tell one of our own room links apart from an arbitrary 8x8.vc URL.
export const JAAS_APP_ID_PREFIX = 'vpaas-magic-cookie-';

// Two hours. Long enough that a meeting never dies mid-sentence, short enough
// that a token copied out of the network tab is worthless by tomorrow. The token
// is minted per participant on join, so there is no reason to make it longer.
export const JAAS_TOKEN_TTL_SECONDS = 2 * 60 * 60;

export interface JaasConfig {
  /** `vpaas-magic-cookie-…` — public, it appears in the room URL. */
  appId: string;
  /** The API key's id, used as the JWT `kid`: `vpaas-magic-cookie-…/abc123`. */
  apiKeyId: string;
  /** RSA private key, PEM. Secret. */
  privateKey: string;
}

// Env files are a hostile place for a multi-line PEM: `.env` parsers keep the
// literal `\n`, and people commonly base64 the whole key to sidestep that. Both
// spellings are accepted so a working key is never rejected over formatting.
function normalizePrivateKey(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (trimmed.includes('BEGIN')) return trimmed.replace(/\\n/g, '\n');
  try {
    const decoded = Buffer.from(trimmed, 'base64').toString('utf8');
    return decoded.includes('BEGIN') ? decoded : '';
  } catch {
    return '';
  }
}

// All three parts or nothing: a half-configured tenant would mint tokens 8x8
// rejects, which looks to the user like "the call is broken" rather than like
// "the feature is off".
export function jaasConfig(): JaasConfig | null {
  const appId = process.env.JAAS_APP_ID?.trim();
  const apiKeyId = process.env.JAAS_API_KEY_ID?.trim();
  const privateKey = normalizePrivateKey(process.env.JAAS_PRIVATE_KEY ?? '');
  if (!appId || !apiKeyId || !privateKey) return null;
  if (!appId.startsWith(JAAS_APP_ID_PREFIX)) return null;
  return { appId, apiKeyId, privateKey };
}

export function jaasEnabled(): boolean {
  return jaasConfig() !== null;
}

/** The shareable room URL — what we store in `Meeting.meetLink` and email out. */
export function jaasRoomUrl(config: JaasConfig, room: string): string {
  return `https://${JAAS_HOST}/${config.appId}/${room}`;
}

export interface JaasTokenUser {
  id: string;
  name?: string | null;
  email?: string | null;
  /** Moderators can mute others and end the call; the organizer gets it. */
  moderator: boolean;
}

function base64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

// The JaaS token: RS256, `kid` = the API key id, `sub` = the app id, and `room`
// scoped to the one room the caller is entitled to — never `*`, which would let
// a leaked token open any room on the tenant.
//
// Signed with node:crypto rather than a JWT library on purpose: this is the
// whole of RFC 7515 that we need, and the project has no direct jose/
// jsonwebtoken dependency to reuse.
export function signJaasToken(
  config: JaasConfig,
  args: { room: string; user: JaasTokenUser; ttlSeconds?: number }
): string {
  const now = Math.floor(Date.now() / 1000);
  const ttl = args.ttlSeconds ?? JAAS_TOKEN_TTL_SECONDS;

  const header = { alg: 'RS256', typ: 'JWT', kid: config.apiKeyId };
  const payload = {
    aud: 'jitsi',
    iss: 'chat',
    sub: config.appId,
    room: args.room,
    iat: now,
    // A few seconds of slack: the container's clock and 8x8's need not agree to
    // the second, and an `nbf` in the future is rejected outright.
    nbf: now - 30,
    exp: now + ttl,
    context: {
      user: {
        id: args.user.id,
        name: args.user.name || 'Guest',
        email: args.user.email || '',
        avatar: '',
        moderator: args.user.moderator,
        'hidden-from-recorder': false,
      },
      // Premium features stay off: they are billed per use, and nothing in the
      // app asks for them. Recording in particular would be a consent question
      // (docs/DATA_ACCESS_POLICY.md), not a flag to flip quietly.
      features: {
        livestreaming: false,
        recording: false,
        transcription: false,
        'outbound-call': false,
        'sip-outbound-call': false,
        'file-upload': false,
        'list-visitors': false,
        flip: false,
      },
    },
  };

  const signingInput = `${base64url(header)}.${base64url(payload)}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(config.privateKey).toString('base64url');
  return `${signingInput}.${signature}`;
}
